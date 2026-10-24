import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  acknowledgmentExample,
  assignmentExample,
  completionExample,
  exampleRepoCommit,
  happyPathEvents,
  intakeExample,
  qaAcceptExample,
  qaReworkExample,
  qaWaitingExample,
  revisionOne,
  revisionTwo,
} from "./examples.ts";
import { leaseIdFor } from "./canonical.ts";
import {
  LEGAL_EVENTS,
  acceptedRevision,
  applySequence,
  applySequenceEvent,
  decodeSequenceState,
  initialSequenceState,
  kanbanColumn,
  type SequenceEvent,
  type SequenceState,
} from "./sequence.ts";

const failure = (state: unknown, event: unknown) => Effect.flip(applySequenceEvent(state, event));

it.effect("runs request, assignment, execution, QA, rework, and an accepted result", () =>
  Effect.gen(function* () {
    const phases: Array<SequenceState["phase"]> = [];
    let state = initialSequenceState;
    for (const event of happyPathEvents) {
      state = yield* applySequenceEvent(state, event);
      phases.push(state.phase);
    }

    assert.deepStrictEqual(phases, [
      "requested",
      "acknowledged",
      "assigned",
      "executing",
      "awaiting_qa",
      "awaiting_qa",
      "rework",
      "executing",
      "awaiting_qa",
      "accepted",
    ]);
    if (state.phase !== "accepted") {
      return yield* Effect.die("The happy path must accept the final revision.");
    }
    assert.strictEqual(state.acknowledgment.taskLink, "ai-os://tasks/task-usba-page");
    assert.deepStrictEqual(state.completion.artifactRevision, revisionTwo);
    assert.deepStrictEqual(acceptedRevision(state), revisionTwo);
    assert.strictEqual(kanbanColumn(state.phase), "Done");
    assert.strictEqual(kanbanColumn("awaiting_qa"), "Review");
    assert.strictEqual(kanbanColumn("recovery_pending"), "Blocked");
  }),
);

it.effect("confirms only after the intake is a durable receipt", () =>
  Effect.gen(function* () {
    const early = yield* failure(initialSequenceState, {
      type: "acknowledge",
      acknowledgment: acknowledgmentExample,
    });
    assert.strictEqual(early.reason, "confirmation_before_durable_receipt");

    const requested = yield* applySequenceEvent(initialSequenceState, {
      type: "intake",
      intake: intakeExample,
    });
    assert.strictEqual(requested.phase, "requested");
    assert.strictEqual("acknowledgment" in requested, false);
    assert.strictEqual(kanbanColumn(requested.phase), "Backlog");

    const acknowledged = yield* applySequenceEvent(requested, {
      type: "acknowledge",
      acknowledgment: acknowledgmentExample,
    });
    if (acknowledged.phase !== "acknowledged") {
      return yield* Effect.die("Acknowledge must record the task.");
    }
    assert.strictEqual(acknowledged.acknowledgment.taskId, "task-usba-page");
    const assignedTooSoon = yield* failure(requested, {
      type: "assign",
      assignment: assignmentExample,
    });
    assert.strictEqual(assignedTooSoon.reason, "illegal_transition");
  }),
);

it.effect("keeps a completion claim out of acceptance until independent QA", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    const submitted = yield* applySequenceEvent(executing, {
      type: "submit_completion",
      completion: completionExample,
    });
    assert.strictEqual(submitted.phase, "awaiting_qa");
    assert.strictEqual(acceptedRevision(submitted), null);
    assert.strictEqual(kanbanColumn(submitted.phase), "Review");

    const waiting = yield* applySequenceEvent(submitted, { type: "qa", qa: qaWaitingExample });
    assert.strictEqual(waiting.phase, "awaiting_qa");
    assert.strictEqual(acceptedRevision(waiting), null);
    const bypass = yield* failure(waiting, { type: "start_execution" });
    assert.strictEqual(bypass.reason, "illegal_transition");
    assert.strictEqual(bypass.from, "awaiting_qa");
  }),
);

it.effect("records an advisory review without creating a QA verdict", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    assert.strictEqual(executing.phase, "executing");
    const review = {
      version: "v1" as const,
      taskId: assignmentExample.taskId,
      attemptId: assignmentExample.attemptId,
      generation: 1,
      leaseId: leaseIdFor(1),
      mode: "advisory" as const,
      commit: exampleRepoCommit,
      model: {
        requested: "gemini-4-argon-high",
        actual: "gemini-4-argon-high",
        unverified: false,
      },
      findings: [
        {
          commit: exampleRepoCommit,
          files: ["src/page.tsx"],
          evidence: "The page lists Saturday only.",
          suggestedAction: "Add Sunday to the schedule.",
        },
      ],
      artifacts: [],
      evidence: [{ kind: "commit" as const, ref: exampleRepoCommit }],
      sourcePath: "/tmp/source",
      scratchPath: "/tmp/scratch",
    };
    const recorded = yield* applySequenceEvent(executing, { type: "record_advisory", review });
    assert.strictEqual(recorded.phase, "executing");
    if (recorded.phase !== "executing") return;
    assert.deepStrictEqual(recorded.run.advisory?.model.requested, {
      model: "gemini-4-argon-high",
    });
    assert.strictEqual(recorded.run.advisory?.findings.length, 1);
    assert.equal("qa" in recorded, false);

    const otherCommit = yield* failure(executing, {
      type: "record_advisory",
      review: { ...review, commit: "a".repeat(40), findings: [] },
    });
    assert.strictEqual(otherCommit.reason, "revision_mismatch");
  }),
);

it.effect("delivers an advisory review without entering QA", () =>
  Effect.gen(function* () {
    const advisory = {
      ...assignmentExample,
      taskType: "advisory" as const,
    };
    const executing = yield* applySequence([
      happyPathEvents[0]!,
      happyPathEvents[1]!,
      { type: "assign", assignment: advisory },
      { type: "start_execution" },
    ]);
    const review = {
      version: "v1" as const,
      taskId: assignmentExample.taskId,
      attemptId: assignmentExample.attemptId,
      generation: 1,
      leaseId: leaseIdFor(1),
      mode: "advisory" as const,
      commit: exampleRepoCommit,
      model: {
        requested: "gemini-4-argon-high",
        actual: "gemini-4-argon-high",
        unverified: false,
      },
      findings: [
        {
          commit: exampleRepoCommit,
          files: ["src/page.tsx"],
          evidence: "The page lists Saturday only.",
          suggestedAction: "Add Sunday to the schedule.",
        },
      ],
      artifacts: [],
      evidence: [{ kind: "commit" as const, ref: exampleRepoCommit }],
      sourcePath: "/tmp/source",
      scratchPath: "/tmp/scratch",
    };
    const recorded = yield* applySequenceEvent(executing, { type: "record_advisory", review });
    const refused = yield* failure(recorded, {
      type: "submit_completion",
      completion: completionExample,
    });
    assert.strictEqual(refused.reason, "illegal_transition");
    const delivered = yield* applySequenceEvent(recorded, {
      type: "deliver_review",
      generation: 1,
      leaseId: leaseIdFor(1),
    });
    assert.strictEqual(delivered.phase, "review_delivered");
    if (delivered.phase !== "review_delivered") return;
    assert.strictEqual(delivered.reviewLabel, "Review delivered");
    assert.strictEqual(kanbanColumn(delivered.phase), "Done");
    assert.strictEqual(acceptedRevision(delivered), null);
    assert.strictEqual(delivered.run.advisory?.commit, exampleRepoCommit);
    assert.strictEqual(delivered.run.advisory?.findings.length, 1);
    const approved = yield* failure(delivered, { type: "qa", qa: qaAcceptExample });
    assert.strictEqual(approved.reason, "illegal_transition");

    const implementation = yield* applySequence([
      happyPathEvents[0]!,
      happyPathEvents[1]!,
      {
        type: "assign",
        assignment: { ...assignmentExample, taskType: "implementation" as const },
      },
      { type: "start_execution" },
      { type: "submit_completion", completion: completionExample },
    ]);
    assert.strictEqual(implementation.phase, "awaiting_qa");
  }),
);

it.effect("compares QA with the model that ran, not only the assigned model", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence([
      happyPathEvents[0]!,
      happyPathEvents[1]!,
      {
        type: "assign",
        assignment: { ...assignmentExample, implementerModel: "gpt-6-sol" },
      },
      { type: "start_execution" },
      {
        type: "report_usage",
        generation: 1,
        leaseId: leaseIdFor(1),
        measurement: {
          kind: "reported_tokens" as const,
          inputTokens: 4,
          outputTokens: 2,
          attribution: {
            projectId: "usba",
            taskId: assignmentExample.taskId,
            attemptId: assignmentExample.attemptId,
            agentId: "codex-t3",
            platform: "t3" as const,
            provider: "openai",
            model: "gpt-6-astra-high",
          },
        },
      },
      { type: "submit_completion", completion: completionExample },
    ]);
    if (executing.phase !== "awaiting_qa") return yield* Effect.die("Completion must wait for QA.");
    assert.deepStrictEqual(executing.run.executedModel, { model: "gpt-6-astra-high" });
    const sameBase = yield* failure(executing, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "gpt-6-astra",
        implementerModel: "gpt-6-sol",
      },
    });
    assert.strictEqual(sameBase.reason, "qa_same_model");
    const namedAssignment = yield* failure(executing, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "gemini-4-argon-high",
        implementerModel: "gpt-6-sol",
      },
    });
    assert.strictEqual(namedAssignment.reason, "implementer_mismatch");
    const reviewed = yield* applySequenceEvent(executing, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "gemini-4-argon-high",
        implementerModel: "gpt-6-astra-high",
      },
    });
    assert.strictEqual(reviewed.phase, "rework");
    const wrongRevision = yield* failure(executing, {
      type: "qa",
      qa: {
        ...qaAcceptExample,
        qaModel: "gemini-4-argon-high",
        implementerModel: "gpt-6-astra-high",
        artifactRevision: { type: "git", sha: "b".repeat(40) },
        acceptedRevision: { type: "git", sha: "b".repeat(40) },
      },
    });
    assert.strictEqual(wrongRevision.reason, "acceptance_revision_mismatch");
  }),
);

it.effect("treats Argon efforts as one base and keeps Sol and Astra distinct", () =>
  Effect.gen(function* () {
    const argon = yield* applySequence([
      happyPathEvents[0]!,
      happyPathEvents[1]!,
      {
        type: "assign",
        assignment: { ...assignmentExample, implementerModel: "gemini-4-argon-high" },
      },
      { type: "start_execution" },
      { type: "submit_completion", completion: completionExample },
    ]);
    const sameBase = yield* failure(argon, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "gemini-4-argon-medium",
        implementerModel: "gpt-6-sol",
      },
    });
    assert.strictEqual(sameBase.reason, "qa_same_model");

    const sol = yield* applySequence([
      happyPathEvents[0]!,
      happyPathEvents[1]!,
      {
        type: "assign",
        assignment: { ...assignmentExample, implementerModel: "gpt-6-sol" },
      },
      { type: "start_execution" },
      { type: "submit_completion", completion: completionExample },
    ]);
    const reviewed = yield* applySequenceEvent(sol, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "gpt-6-astra",
        implementerModel: "gpt-6-sol",
      },
    });
    assert.strictEqual(reviewed.phase, "rework");
  }),
);

it.effect("requires QA to use a different model than the assigned implementer", () =>
  Effect.gen(function* () {
    if (qaReworkExample.availability !== "available") {
      return yield* Effect.die("The rework example must be an available verdict.");
    }
    const awaiting = yield* applySequence(happyPathEvents.slice(0, 5));
    const sameModel = yield* failure(awaiting, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: assignmentExample.implementerModel,
        implementerModel: "claude-sonnet-5",
      },
    });
    assert.strictEqual(sameModel.reason, "qa_same_model");

    const otherImplementer = yield* failure(awaiting, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "claude-sonnet-5",
        implementerModel: "grok-4",
      },
    });
    assert.strictEqual(otherImplementer.reason, "implementer_mismatch");
  }),
);

it.effect("binds acceptance to the exact final revision", () =>
  Effect.gen(function* () {
    const awaitingRework = yield* applySequence(happyPathEvents.slice(0, 6));
    const rework = yield* applySequenceEvent(awaitingRework, { type: "qa", qa: qaReworkExample });
    const executing = yield* applySequenceEvent(rework, { type: "start_execution" });
    if (executing.phase !== "executing") {
      return yield* Effect.die("Rework must be executing before the repeated submission.");
    }
    const repeated = yield* failure(executing, {
      type: "submit_completion",
      completion: {
        ...completionExample,
        generation: executing.run.generation,
        leaseId: executing.run.leaseId,
      },
    });
    assert.strictEqual(repeated.reason, "revision_mismatch");

    const corrected = yield* applySequence(happyPathEvents.slice(0, 9));
    if (qaAcceptExample.availability !== "available" || qaAcceptExample.verdict !== "accept") {
      return yield* Effect.die("The accept example must accept a revision.");
    }
    const stale = yield* failure(corrected, {
      type: "qa",
      qa: { ...qaAcceptExample, artifactRevision: revisionOne, acceptedRevision: revisionOne },
    });
    assert.strictEqual(stale.reason, "acceptance_revision_mismatch");

    const accepted = yield* applySequenceEvent(corrected, { type: "qa", qa: qaAcceptExample });
    assert.deepStrictEqual(acceptedRevision(accepted), revisionTwo);
    const changedAgain = yield* applySequenceEvent(accepted, { type: "start_execution" });
    assert.strictEqual(changedAgain.phase, "executing");
    assert.strictEqual(acceptedRevision(changedAgain), null);
  }),
);

it.effect("blocks an expired lease as recovery_pending and does not return it to Ready", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    const blocked = yield* applySequenceEvent(executing, {
      type: "lease_expired",
      lease: {
        taskId: "task-usba-page",
        attemptId: "attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
      },
    });
    if (blocked.phase !== "recovery_pending") {
      return yield* Effect.die("An expired lease must be recovery_pending.");
    }
    assert.strictEqual(blocked.recoveryLabel, "Execution status unknown");
    assert.strictEqual(kanbanColumn(blocked.phase), "Blocked");

    const events: ReadonlyArray<SequenceEvent> = [
      { type: "intake", intake: intakeExample },
      { type: "acknowledge", acknowledgment: acknowledgmentExample },
      { type: "assign", assignment: assignmentExample },
      { type: "start_execution" },
      {
        type: "lease_expired",
        lease: {
          taskId: "task-usba-page",
          attemptId: "attempt-1",
          generation: 1,
          leaseId: leaseIdFor(1),
        },
      },
      { type: "submit_completion", completion: completionExample },
      { type: "qa", qa: qaAcceptExample },
    ];
    for (const event of events) {
      const error = yield* failure(blocked, event);
      assert.strictEqual(error.reason, "recovery_pending_not_ready");
    }
    assert.deepStrictEqual(LEGAL_EVENTS.recovery_pending, ["resolve_recovery"]);
  }),
);

it.effect("rejects a completion or QA payload for a different task", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    const otherTask = yield* failure(executing, {
      type: "submit_completion",
      completion: { ...completionExample, taskId: "task-other" },
    });
    assert.strictEqual(otherTask.reason, "task_mismatch");
    const awaiting = yield* applySequenceEvent(executing, {
      type: "submit_completion",
      completion: completionExample,
    });
    const otherAttempt = yield* failure(awaiting, {
      type: "qa",
      qa: { ...qaWaitingExample, attemptId: "attempt-2" },
    });
    assert.strictEqual(otherAttempt.reason, "attempt_mismatch");
  }),
);

it.effect("does not treat a differently cased model id as a different QA model", () =>
  Effect.gen(function* () {
    if (qaReworkExample.availability !== "available") {
      return yield* Effect.die("The rework example must be an available verdict.");
    }
    const awaiting = yield* applySequence(happyPathEvents.slice(0, 5));
    const cased = yield* failure(awaiting, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "GPT-5.4",
        implementerModel: "claude-sonnet-5",
      },
    });
    assert.strictEqual(cased.reason, "qa_same_model");

    const acknowledged = yield* applySequence(happyPathEvents.slice(0, 2));
    const assigned = yield* applySequenceEvent(acknowledged, {
      type: "assign",
      assignment: { ...assignmentExample, implementerModel: "openai/gpt-5.4" },
    });
    const executing = yield* applySequenceEvent(assigned, { type: "start_execution" });
    const submitted = yield* applySequenceEvent(executing, {
      type: "submit_completion",
      completion: completionExample,
    });
    const prefixed = yield* failure(submitted, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "OpenAI:GPT-5.4",
        implementerModel: "claude-sonnet-5",
      },
    });
    assert.strictEqual(prefixed.reason, "qa_same_model");

    const azure = yield* failure(submitted, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "azure/gpt-5.4",
        implementerModel: "claude-sonnet-5",
      },
    });
    assert.strictEqual(azure.reason, "qa_same_model");

    const bare = yield* failure(awaiting, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "openai/gpt-5.4",
        implementerModel: "claude-sonnet-5",
      },
    });
    assert.strictEqual(bare.reason, "qa_same_model");
  }),
);

it.effect("rejects an acknowledgment that is not the task URI", () =>
  Effect.gen(function* () {
    const requested = yield* applySequence(happyPathEvents.slice(0, 1));
    const nonLink = yield* failure(requested, {
      type: "acknowledge",
      acknowledgment: { ...acknowledgmentExample, taskLink: "task-usba-page" },
    });
    assert.strictEqual(nonLink.reason, "invalid_payload");
    assert.strictEqual(nonLink.event, "acknowledge");
  }),
);

it.effect("rejects a QA model id that is not in the model alphabet", () =>
  Effect.gen(function* () {
    if (qaReworkExample.availability !== "available") {
      return yield* Effect.die("The rework example must be an available verdict.");
    }
    const awaiting = yield* applySequence(happyPathEvents.slice(0, 5));
    const hidden = yield* failure(awaiting, {
      type: "qa",
      qa: {
        ...qaReworkExample,
        qaModel: "gpt-\u200b5.4",
        implementerModel: "claude-sonnet-5",
      },
    });
    assert.strictEqual(hidden.reason, "invalid_payload");
    assert.strictEqual(hidden.event, "qa");
  }),
);

it.effect("rejects schema-invalid input on every transition", () =>
  Effect.gen(function* () {
    const requested = yield* applySequence(happyPathEvents.slice(0, 1));
    const acknowledged = yield* applySequence(happyPathEvents.slice(0, 2));
    const assigned = yield* applySequence(happyPathEvents.slice(0, 3));
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    const awaiting = yield* applySequence(happyPathEvents.slice(0, 5));
    const cases = [
      [initialSequenceState, { type: "intake", intake: { ...intakeExample, request: "   " } }],
      [
        requested,
        {
          type: "acknowledge",
          acknowledgment: { ...acknowledgmentExample, taskLink: "not a link" },
        },
      ],
      [
        acknowledged,
        { type: "assign", assignment: { ...assignmentExample, implementerModel: "gpt-\u200b5.4" } },
      ],
      [assigned, { type: "start_execution", extra: true }],
      [executing, { type: "lease_expired", extra: true }],
      [
        executing,
        {
          type: "submit_completion",
          completion: { ...completionExample, evidence: [] },
        },
      ],
      [
        awaiting,
        {
          type: "qa",
          qa: { ...qaReworkExample, qaModel: "gpt-\u200b5.4" },
        },
      ],
      [
        executing,
        {
          type: "report_progress",
          report: {
            version: "v1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            generation: 1,
            leaseId: leaseIdFor(1),
            status: "working",
            blockers: [
              {
                summary: "The preview is down.",
                ownerId: "t3-codex",
                nextAction: "Restore the preview.",
              },
            ],
            partialArtifacts: [],
          },
        },
      ],
      [
        executing,
        {
          type: "heartbeat",
          heartbeat: {
            version: "v1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            generation: 1,
            leaseId: "lease-1",
            observedAt: "2026-10-21T15:00:00Z",
            leaseExpiresAt: "2026-10-21T15:00:00Z",
          },
        },
      ],
      [
        executing,
        {
          type: "heartbeat_lapsed",
          lapse: {
            version: "v1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            generation: 0,
            leaseId: leaseIdFor(1),
          },
        },
      ],
      [
        executing,
        {
          type: "report_usage",
          generation: 1,
          leaseId: leaseIdFor(1),
          measurement: {
            kind: "reported_tokens",
            inputTokens: 1,
            outputTokens: 1,
            amountMinor: 5,
            attribution: {
              projectId: "usba",
              taskId: "task-usba-page",
              attemptId: "attempt-1",
              agentId: "codex",
              platform: "t3",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        },
      ],
      [
        executing,
        {
          type: "cancel",
          command: {
            command: "cancel",
            idempotencyKey: "cancel-1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            claimedOutcome: "done",
          },
        },
      ],
      [
        executing,
        {
          type: "continue",
          command: { command: "continue", idempotencyKey: "continue-1", taskId: "task-usba-page" },
        },
      ],
      [
        executing,
        {
          type: "retry",
          command: {
            command: "cancel",
            idempotencyKey: "retry-1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
          },
        },
      ],
      [
        executing,
        {
          type: "transfer_ownership",
          command: {
            command: "transfer_ownership",
            idempotencyKey: "transfer-1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
          },
        },
      ],
      [
        executing,
        {
          type: "fail",
          command: {
            command: "fail",
            idempotencyKey: "fail-1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            blocker: {
              summary: "The build failed.",
              ownerId: "t3-codex",
              nextAction: "Read the log.",
            },
          },
        },
      ],
      [
        executing,
        {
          type: "fail",
          failure: {
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            generation: 1,
            leaseId: "lease-1",
            blocker: { summary: "The build failed.", ownerId: "t3-codex", nextAction: " " },
          },
        },
      ],
      [
        executing,
        {
          type: "operator_fail",
          command: {
            command: "operator_fail",
            idempotencyKey: "fail-1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            blocker: {
              summary: "The build failed.",
              ownerId: "t3-codex",
              nextAction: "Read the log.",
            },
          },
        },
      ],
      [
        executing,
        {
          type: "resolve_recovery",
          command: {
            command: "resolve_recovery",
            outcome: "fail",
            idempotencyKey: "resolve-1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
          },
        },
      ],
      [
        executing,
        {
          type: "deliver",
          delivery: {
            version: "v1",
            taskId: "task-usba-page",
            attemptId: "attempt-1",
            acceptedRevision: revisionTwo,
            destination: "conversation",
            idempotencyKey: "deliver-1",
            deliveredAt: "2026-10-21T16:00:00Z",
          },
        },
      ],
      [
        executing,
        {
          type: "submit_completion",
          completion: { ...completionExample, idempotencyKey: "claim-1" },
        },
      ],
    ] as const;
    for (const [state, event] of cases) {
      const error = yield* failure(state, event);
      assert.strictEqual(error.reason, "invalid_payload");
    }
  }),
);

it.effect("rejects abbreviated and truncated git revisions on submission", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    const abbreviated = yield* failure(executing, {
      type: "submit_completion",
      completion: {
        ...completionExample,
        artifactRevision: { type: "git", sha: "abc1234" },
      },
    });
    const truncated = yield* failure(executing, {
      type: "submit_completion",
      completion: {
        ...completionExample,
        artifactRevision: { type: "git", sha: "a".repeat(39) },
      },
    });
    assert.strictEqual(abbreviated.reason, "invalid_payload");
    assert.strictEqual(truncated.reason, "invalid_payload");
  }),
);

it.effect("rejects an accepted phase that has no completion or independent QA verdict", () =>
  Effect.gen(function* () {
    const bare = yield* Effect.exit(decodeSequenceState({ phase: "accepted" }));
    const executingOnly = yield* Effect.exit(
      decodeSequenceState({
        phase: "executing",
        intake: intakeExample,
        acknowledgment: acknowledgmentExample,
      }),
    );
    const accepted = yield* applySequence(happyPathEvents);
    const decoded = yield* decodeSequenceState(accepted);
    assert.strictEqual(Exit.isFailure(bare), true);
    assert.strictEqual(Exit.isFailure(executingOnly), true);
    assert.strictEqual(decoded.phase, "accepted");
    assert.strictEqual(kanbanColumn(decoded.phase), "Done");
    if (accepted.phase !== "accepted") {
      return yield* Effect.die("The happy path must accept the final revision.");
    }
    const sameModel = yield* Effect.exit(
      decodeSequenceState({
        ...accepted,
        qa: { ...accepted.qa, qaModel: accepted.assignment.implementerModel },
      }),
    );
    const awaiting = yield* applySequence(happyPathEvents.slice(0, 5));
    const acceptedTooEarly = yield* Effect.exit(
      decodeSequenceState({ ...awaiting, qa: qaAcceptExample }),
    );
    const bareFailed = yield* Effect.exit(decodeSequenceState({ phase: "failed" }));
    const bareCancelled = yield* Effect.exit(decodeSequenceState({ phase: "cancelled" }));
    assert.strictEqual(Exit.isFailure(sameModel), true);
    assert.strictEqual(Exit.isFailure(acceptedTooEarly), true);
    assert.strictEqual(Exit.isFailure(bareFailed), true);
    assert.strictEqual(Exit.isFailure(bareCancelled), true);
  }),
);

it.effect("stores an assignment snapshot that later caller mutation cannot change", () =>
  Effect.gen(function* () {
    const memoryVersions = ["decision-12"];
    const source = {
      version: "v1" as const,
      taskId: "task-usba-page",
      attemptId: "attempt-1",
      assignmentId: "assignment-freeze",
      workerId: "t3-codex",
      implementerModel: "gpt-5.4",
      scope: "Update the USBA tournament page.",
      contextPackage: {
        requirements: "The tournament page shows the new schedule.",
        memoryVersions,
        repoCommit: exampleRepoCommit,
        authorizationScope: "usba-web",
        createdAt: "2026-10-21T14:01:00Z",
      },
    };
    const acknowledged = yield* applySequence(happyPathEvents.slice(0, 2));
    const assigned = yield* applySequenceEvent(acknowledged, {
      type: "assign",
      assignment: source,
    });
    if (assigned.phase !== "assigned") {
      return yield* Effect.die("Assign must store the snapshot.");
    }
    memoryVersions.push("caller-mutation");
    source.contextPackage.requirements = "changed by caller";
    assert.deepStrictEqual(assigned.assignment.contextPackage.memoryVersions, ["decision-12"]);
    assert.strictEqual(
      assigned.assignment.contextPackage.requirements,
      "The tournament page shows the new schedule.",
    );
    assert.strictEqual(Object.isFrozen(source), false);
    assert.strictEqual(Object.isFrozen(source.contextPackage), false);
    assert.strictEqual(Object.isFrozen(assigned.assignment), true);
    assert.strictEqual(Object.isFrozen(assigned.assignment.contextPackage), true);
    assert.throws(() => {
      (assigned.assignment.contextPackage.memoryVersions as Array<string>).push("stored-mutation");
    });
  }),
);

it.effect("treats a rework revision as stale when only the git SHA case differs", () =>
  Effect.gen(function* () {
    const rework = yield* applySequence(happyPathEvents.slice(0, 7));
    if (rework.phase !== "rework" || rework.reworkRevision.type !== "git") {
      return yield* Effect.die("Rework must record the reviewed git revision.");
    }
    const executing = yield* applySequenceEvent(rework, { type: "start_execution" });
    if (executing.phase !== "executing") {
      return yield* Effect.die("Rework must be executing before the repeated submission.");
    }
    const repeated = yield* failure(executing, {
      type: "submit_completion",
      completion: {
        ...completionExample,
        generation: executing.run.generation,
        leaseId: executing.run.leaseId,
        artifactRevision: { type: "git", sha: rework.reworkRevision.sha.toUpperCase() },
      },
    });
    assert.strictEqual(repeated.reason, "revision_mismatch");
  }),
);

it.effect("rejects stored progress or completion that names a different run", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    if (executing.phase !== "executing") {
      return yield* Effect.die("The run must be executing.");
    }
    const forgedProgress = {
      ...executing,
      run: {
        ...executing.run,
        progress: {
          version: "v1" as const,
          taskId: "task-usba-page",
          attemptId: "attempt-1",
          generation: 2,
          leaseId: leaseIdFor(2),
          status: "working" as const,
          blockers: [],
          partialArtifacts: [],
        },
      },
    };
    const progressState = yield* Effect.exit(decodeSequenceState(forgedProgress));
    const progressWrite = yield* failure(forgedProgress, { type: "start_execution" });
    assert.strictEqual(Exit.isFailure(progressState), true);
    assert.strictEqual(progressWrite.reason, "invalid_payload");
    assert.strictEqual(progressWrite.from, "executing");

    const awaiting = yield* applySequence(happyPathEvents.slice(0, 5));
    if (awaiting.phase !== "awaiting_qa") {
      return yield* Effect.die("The completion must be awaiting QA.");
    }
    const forgedCompletion = {
      ...awaiting,
      completion: {
        ...awaiting.completion,
        generation: awaiting.run.generation,
        leaseId: "lease-9",
      },
    };
    const completionState = yield* Effect.exit(decodeSequenceState(forgedCompletion));
    const qaOverStale = yield* failure(forgedCompletion, { type: "qa", qa: qaWaitingExample });
    assert.strictEqual(Exit.isFailure(completionState), true);
    assert.strictEqual(qaOverStale.reason, "invalid_payload");
    assert.strictEqual(qaOverStale.from, "awaiting_qa");
    assert.strictEqual(qaOverStale.event, "qa");

    const accepted = yield* applySequence(happyPathEvents);
    if (accepted.phase !== "accepted") {
      return yield* Effect.die("The happy path must be accepted.");
    }
    const forgedAccepted = {
      ...accepted,
      completion: { ...accepted.completion, generation: accepted.run.generation + 1 },
    };
    const acceptedState = yield* Effect.exit(decodeSequenceState(forgedAccepted));
    assert.strictEqual(Exit.isFailure(acceptedState), true);
  }),
);
