import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { leaseIdFor } from "./canonical.ts";
import { completionExample, happyPathEvents, revisionOne, revisionTwo } from "./examples.ts";
import { applySequence, applySequenceEvent, kanbanColumn, type SequenceState } from "./sequence.ts";
import { usageTotals } from "./usage.ts";

const taskId = "task-usba-page";
const attemptId = "attempt-1";
const observedAt = "2026-10-21T15:00:00Z";
const leaseExpiresAt = "2026-10-21T16:00:00Z";

const failure = (state: unknown, event: unknown) => Effect.flip(applySequenceEvent(state, event));

const attribution = {
  projectId: "usba",
  taskId,
  attemptId,
  agentId: "codex",
  platform: "t3" as const,
  provider: "openai",
  model: "gpt-5.4",
};

const blocker = {
  summary: "The build failed.",
  ownerId: "t3-codex",
  nextAction: "Read the build log and retry.",
};

const progress = (generation: number, status: "working" | "blocked" = "working") => ({
  version: "v1" as const,
  taskId,
  attemptId,
  generation,
  leaseId: leaseIdFor(generation),
  status,
  blockers: status === "blocked" ? [blocker] : [],
  partialArtifacts:
    status === "working"
      ? [{ artifactId: "page", revision: revisionOne, note: "The Saturday schedule is updated." }]
      : [],
});

const heartbeat = (generation: number) => ({
  version: "v1" as const,
  taskId,
  attemptId,
  generation,
  leaseId: leaseIdFor(generation),
  observedAt,
  leaseExpiresAt,
});

const lapse = (generation: number) => ({
  version: "v1" as const,
  taskId,
  attemptId,
  generation,
  leaseId: leaseIdFor(generation),
});

const expired = (generation: number) => ({
  type: "lease_expired" as const,
  lease: {
    taskId,
    attemptId,
    generation,
    leaseId: leaseIdFor(generation),
  },
});

const command = (name: string, idempotencyKey: string, extra: Record<string, unknown> = {}) => ({
  command: name,
  idempotencyKey,
  taskId,
  attemptId,
  ...extra,
});

const requirePhase = <Phase extends SequenceState["phase"]>(state: SequenceState, phase: Phase) => {
  if (state.phase !== phase) {
    return Effect.die(`Expected ${phase}, received ${state.phase}.`);
  }
  return Effect.succeed(state as Extract<SequenceState, { phase: Phase }>);
};

it.effect("fences stale progress and turns a lapsed heartbeat into recovery_pending", () =>
  Effect.gen(function* () {
    const executing = yield* requirePhase(
      yield* applySequence(happyPathEvents.slice(0, 4)),
      "executing",
    );
    assert.strictEqual(executing.run.generation, 1);

    const report = progress(1);
    const reported = yield* requirePhase(
      yield* applySequenceEvent(executing, { type: "report_progress", report }),
      "executing",
    );
    report.partialArtifacts.push({
      artifactId: "caller",
      revision: revisionOne,
      note: "changed by caller",
    });
    const storedProgress = reported.run.progress;
    if (storedProgress === null) {
      return yield* Effect.die("Progress must be stored.");
    }
    assert.strictEqual(storedProgress.partialArtifacts.length, 1);
    assert.throws(() => {
      (storedProgress.partialArtifacts as Array<unknown>).push("stored");
    });

    const stale = yield* failure(executing, { type: "report_progress", report: progress(2) });
    assert.strictEqual(stale.reason, "stale_generation");
    assert.strictEqual(executing.run.progress, null);

    const beating = yield* requirePhase(
      yield* applySequenceEvent(reported, { type: "heartbeat", heartbeat: heartbeat(1) }),
      "executing",
    );
    assert.strictEqual(beating.run.leaseExpiresAt, leaseExpiresAt);

    const staleLapse = yield* failure(beating, { type: "heartbeat_lapsed", lapse: lapse(2) });
    assert.strictEqual(staleLapse.reason, "stale_generation");
    assert.strictEqual(beating.phase, "executing");

    const blocked = yield* requirePhase(
      yield* applySequenceEvent(beating, { type: "heartbeat_lapsed", lapse: lapse(1) }),
      "recovery_pending",
    );
    assert.strictEqual(blocked.recoveryLabel, "Execution status unknown");
    assert.strictEqual(kanbanColumn(blocked.phase), "Blocked");
    const resumed = yield* failure(blocked, { type: "start_execution" });
    assert.strictEqual(resumed.reason, "recovery_pending_not_ready");
    assert.strictEqual(blocked.phase, "recovery_pending");

    const shortSha = yield* failure(executing, {
      type: "report_progress",
      report: {
        ...progress(1),
        partialArtifacts: [
          { artifactId: "page", revision: { type: "git", sha: "abc1234" }, note: "Short." },
        ],
      },
    });
    assert.strictEqual(shortSha.reason, "invalid_payload");
  }),
);

it.effect("records usage by kind and keeps the ledger on the attempt", () =>
  Effect.gen(function* () {
    let state = yield* requirePhase(yield* applySequence(happyPathEvents.slice(0, 4)), "executing");
    const measurements = [
      { kind: "reported_tokens" as const, inputTokens: 10, outputTokens: 4, attribution },
      {
        kind: "estimated_cost" as const,
        amountMinor: 250,
        currency: "USD" as const,
        attribution,
      },
      { kind: "subscription_allocation" as const, shareBps: 500, attribution },
      { kind: "unknown" as const, reason: "The provider returned no usage.", attribution },
    ];
    for (const measurement of measurements) {
      state = yield* requirePhase(
        yield* applySequenceEvent(state, {
          type: "report_usage",
          generation: state.run.generation,
          leaseId: state.run.leaseId,
          measurement,
        }),
        "executing",
      );
    }
    const totals = usageTotals(state.run.usage);
    assert.deepStrictEqual(totals.reportedTokens, { input: 10, output: 4 });
    assert.strictEqual(totals.estimatedCostMinorUsd, 250);
    assert.strictEqual(totals.subscriptionAllocationBps, 500);
    assert.strictEqual(totals.unknownCount, 1);

    const otherProject = yield* failure(state, {
      type: "report_usage",
      generation: state.run.generation,
      leaseId: state.run.leaseId,
      measurement: {
        kind: "reported_tokens",
        inputTokens: 1,
        outputTokens: 1,
        attribution: { ...attribution, projectId: "other" },
      },
    });
    assert.strictEqual(otherProject.reason, "task_mismatch");
    assert.strictEqual(otherProject.detail, "The usage project must match the intake project.");
    assert.strictEqual(state.run.usage.length, 4);
  }),
);

it.effect("cancels, continues, retries within a limit, and transfers ownership", () =>
  Effect.gen(function* () {
    const started = yield* requirePhase(
      yield* applySequence(happyPathEvents.slice(0, 4)),
      "executing",
    );
    const executing = yield* requirePhase(
      yield* applySequenceEvent(started, {
        type: "report_usage",
        generation: 1,
        leaseId: leaseIdFor(1),
        measurement: {
          kind: "reported_tokens",
          inputTokens: 3,
          outputTokens: 1,
          attribution,
        },
      }),
      "executing",
    );
    const cancelled = yield* requirePhase(
      yield* applySequenceEvent(executing, {
        type: "cancel",
        command: command("cancel", "cancel-1"),
      }),
      "cancelled",
    );
    assert.strictEqual(kanbanColumn(cancelled.phase), null);
    const replayedCancel = yield* requirePhase(
      yield* applySequenceEvent(cancelled, {
        type: "cancel",
        command: command("cancel", "cancel-1"),
      }),
      "cancelled",
    );
    assert.strictEqual(replayedCancel.commands.length, 1);

    const continued = yield* requirePhase(
      yield* applySequenceEvent(replayedCancel, {
        type: "continue",
        command: command("continue", "continue-1"),
      }),
      "assigned",
    );
    assert.strictEqual(kanbanColumn(continued.phase), "Ready");
    const replayedCancelAfterContinue = yield* requirePhase(
      yield* applySequenceEvent(continued, {
        type: "cancel",
        command: command("cancel", "cancel-1"),
      }),
      "assigned",
    );
    assert.strictEqual(replayedCancelAfterContinue.phase, "assigned");

    const restarted = yield* requirePhase(
      yield* applySequenceEvent(continued, { type: "start_execution" }),
      "executing",
    );
    assert.strictEqual(restarted.run.generation, 2);
    assert.strictEqual(restarted.run.usage.length, 1);
    const staleHeartbeat = yield* failure(restarted, {
      type: "heartbeat",
      heartbeat: heartbeat(1),
    });
    assert.strictEqual(staleHeartbeat.reason, "stale_generation");

    const transferred = yield* requirePhase(
      yield* applySequenceEvent(restarted, {
        type: "transfer_ownership",
        command: command("transfer_ownership", "own-1", { ownerId: "t3-other" }),
      }),
      "executing",
    );
    assert.strictEqual(transferred.assignment.workerId, "t3-other");
    assert.strictEqual(transferred.run.generation, 3);
    const replayedTransfer = yield* requirePhase(
      yield* applySequenceEvent(transferred, {
        type: "transfer_ownership",
        command: command("transfer_ownership", "own-1", { ownerId: "t3-other" }),
      }),
      "executing",
    );
    assert.strictEqual(replayedTransfer.commands.length, transferred.commands.length);
    const otherOwner = yield* failure(transferred, {
      type: "transfer_ownership",
      command: command("transfer_ownership", "own-1", { ownerId: "t3-third" }),
    });
    assert.strictEqual(otherOwner.reason, "idempotency_conflict");
    assert.strictEqual(transferred.assignment.workerId, "t3-other");
    assert.strictEqual(transferred.assignment.attemptId, attemptId);
    const conflict = yield* failure(transferred, {
      type: "fail",
      command: command("fail", "own-1", { blocker }),
    });
    assert.strictEqual(conflict.reason, "idempotency_conflict");
    assert.strictEqual(transferred.phase, "executing");

    let failed = yield* requirePhase(
      yield* applySequenceEvent(transferred, {
        type: "fail",
        command: command("fail", "fail-0", { blocker }),
      }),
      "failed",
    );
    assert.strictEqual(kanbanColumn(failed.phase), null);
    assert.strictEqual(failed.blocker.nextAction, blocker.nextAction);
    for (let count = 0; count < 3; count += 1) {
      const retried = yield* requirePhase(
        yield* applySequenceEvent(failed, {
          type: "retry",
          command: command("retry", `retry-${count}`),
        }),
        "executing",
      );
      assert.strictEqual(retried.run.retryCount, count + 1);
      failed = yield* requirePhase(
        yield* applySequenceEvent(retried, {
          type: "fail",
          command: command("fail", `fail-${count + 1}`, { blocker }),
        }),
        "failed",
      );
    }
    const limited = yield* failure(failed, {
      type: "retry",
      command: command("retry", "retry-3"),
    });
    assert.strictEqual(limited.reason, "retry_limit_reached");
    assert.strictEqual(failed.phase, "failed");
    assert.strictEqual(failed.run.usage.length, 1);
  }),
);

it.effect("leaves recovery_pending only through an explicit resolution", () =>
  Effect.gen(function* () {
    const executing = yield* requirePhase(
      yield* applySequence(happyPathEvents.slice(0, 4)),
      "executing",
    );
    const blocked = yield* requirePhase(
      yield* applySequenceEvent(executing, expired(executing.run.generation)),
      "recovery_pending",
    );
    assert.strictEqual(kanbanColumn(blocked.phase), "Blocked");

    const ready = yield* requirePhase(
      yield* applySequenceEvent(blocked, {
        type: "resolve_recovery",
        command: command("resolve_recovery", "resolve-continue", { outcome: "continue" }),
      }),
      "assigned",
    );
    assert.strictEqual(kanbanColumn(ready.phase), "Ready");
    assert.strictEqual(ready.nextGeneration, blocked.run.generation + 1);

    const restarted = yield* requirePhase(
      yield* applySequenceEvent(ready, { type: "start_execution" }),
      "executing",
    );
    const blockedAgain = yield* requirePhase(
      yield* applySequenceEvent(restarted, expired(restarted.run.generation)),
      "recovery_pending",
    );
    const failed = yield* requirePhase(
      yield* applySequenceEvent(blockedAgain, {
        type: "resolve_recovery",
        command: command("resolve_recovery", "resolve-fail", { outcome: "fail", blocker }),
      }),
      "failed",
    );
    assert.strictEqual(kanbanColumn(failed.phase), null);

    const retried = yield* requirePhase(
      yield* applySequenceEvent(failed, {
        type: "retry",
        command: command("retry", "retry-after-recovery"),
      }),
      "executing",
    );
    const cancelled = yield* requirePhase(
      yield* applySequenceEvent(
        yield* requirePhase(
          yield* applySequenceEvent(retried, expired(retried.run.generation)),
          "recovery_pending",
        ),
        {
          type: "resolve_recovery",
          command: command("resolve_recovery", "resolve-cancel", { outcome: "cancel" }),
        },
      ),
      "cancelled",
    );
    assert.strictEqual(kanbanColumn(cancelled.phase), null);
    const stillBlocked = yield* failure(blocked, {
      type: "deliver",
      delivery: dashboard(revisionTwo),
    });
    assert.strictEqual(stillBlocked.reason, "recovery_pending_not_ready");
  }),
);

const dashboard = (revision: typeof revisionTwo, idempotencyKey = "deliver-dashboard") => ({
  version: "v1" as const,
  taskId,
  attemptId,
  acceptedRevision: revision,
  destination: "dashboard" as const,
  idempotencyKey,
  deliveredAt: leaseExpiresAt,
});

const conversation = (idempotencyKey: string) => ({
  ...dashboard(revisionTwo, idempotencyKey),
  destination: "conversation" as const,
  conversationId: "grok-thread-1",
});

it.effect(
  "delivers an accepted revision once to the dashboard and the originating conversation",
  () =>
    Effect.gen(function* () {
      const accepted = yield* requirePhase(yield* applySequence(happyPathEvents), "accepted");
      const executing = yield* requirePhase(
        yield* applySequence(happyPathEvents.slice(0, 4)),
        "executing",
      );
      const tooEarly = yield* failure(executing, {
        type: "deliver",
        delivery: dashboard(revisionOne),
      });
      assert.strictEqual(tooEarly.reason, "illegal_transition");

      const wrongRevision = yield* failure(accepted, {
        type: "deliver",
        delivery: dashboard(revisionOne),
      });
      assert.strictEqual(wrongRevision.reason, "delivery_revision_mismatch");

      const delivered = yield* requirePhase(
        yield* applySequenceEvent(accepted, { type: "deliver", delivery: dashboard(revisionTwo) }),
        "accepted",
      );
      assert.strictEqual(delivered.deliveries.length, 1);
      assert.strictEqual(delivered.deliveries[0]?.destination, "dashboard");
      assert.strictEqual(delivered.deliveries[0]?.conversationId, undefined);
      assert.deepStrictEqual(delivered.deliveries[0]?.acceptedRevision, revisionTwo);

      const replayed = yield* requirePhase(
        yield* applySequenceEvent(delivered, { type: "deliver", delivery: dashboard(revisionTwo) }),
        "accepted",
      );
      assert.strictEqual(replayed.deliveries.length, 1);
      const changedPayload = yield* failure(replayed, {
        type: "deliver",
        delivery: { ...dashboard(revisionTwo), deliveredAt: "2026-10-21T17:00:00Z" },
      });
      assert.strictEqual(changedPayload.reason, "idempotency_conflict");
      assert.strictEqual(replayed.deliveries.length, 1);
      const otherKey = yield* requirePhase(
        yield* applySequenceEvent(replayed, {
          type: "deliver",
          delivery: dashboard(revisionTwo, "deliver-dashboard-2"),
        }),
        "accepted",
      );
      assert.strictEqual(otherKey.deliveries.length, 1);
      assert.strictEqual(otherKey.deliveries[0]?.idempotencyKey, "deliver-dashboard");

      const reusedKey = yield* failure(otherKey, {
        type: "deliver",
        delivery: conversation("deliver-dashboard"),
      });
      assert.strictEqual(reusedKey.reason, "idempotency_conflict");

      const otherOrigin = yield* failure(otherKey, {
        type: "deliver",
        delivery: { ...conversation("deliver-other"), conversationId: "other-thread" },
      });
      assert.strictEqual(otherOrigin.reason, "delivery_origin_mismatch");
      const both = yield* requirePhase(
        yield* applySequenceEvent(otherKey, {
          type: "deliver",
          delivery: { ...conversation("deliver-conversation"), conversationId: "Grok-Thread-1" },
        }),
        "accepted",
      );
      assert.strictEqual(both.deliveries.length, 2);
      assert.strictEqual(both.deliveries[1]?.conversationId, "grok-thread-1");
      assert.strictEqual(both.intake.originatingConversationId, "grok-thread-1");
      assert.strictEqual(both.phase, "accepted");
    }),
);

it.effect("rejects a worker event whose generation or lease is not current", () =>
  Effect.gen(function* () {
    const executing = yield* requirePhase(
      yield* applySequence(happyPathEvents.slice(0, 4)),
      "executing",
    );
    assert.strictEqual(executing.run.leaseId, leaseIdFor(executing.run.generation));
    const probes = [
      { type: "lease_expired" as const, lease: { ...expired(1).lease, leaseId: "lease-9" } },
      {
        type: "submit_completion" as const,
        completion: { ...completionExample, leaseId: "lease-9" },
      },
      { type: "report_progress" as const, report: { ...progress(1), leaseId: "lease-9" } },
      { type: "heartbeat" as const, heartbeat: { ...heartbeat(1), leaseId: "lease-9" } },
      { type: "heartbeat_lapsed" as const, lapse: { ...lapse(1), leaseId: "lease-9" } },
      {
        type: "report_usage" as const,
        generation: 1,
        leaseId: "lease-9",
        measurement: {
          kind: "unknown" as const,
          reason: "The provider returned no usage.",
          attribution,
        },
      },
      expired(2),
    ];
    for (const event of probes) {
      const error = yield* failure(executing, event);
      assert.strictEqual(error.reason, "stale_generation");
      assert.strictEqual(error.from, "executing");
    }
    const beating = yield* requirePhase(
      yield* applySequenceEvent(executing, { type: "heartbeat", heartbeat: heartbeat(1) }),
      "executing",
    );
    assert.strictEqual(beating.run.leaseId, leaseIdFor(1));
    assert.strictEqual(beating.run.leaseExpiresAt, leaseExpiresAt);
  }),
);
