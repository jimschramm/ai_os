import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { leaseIdFor } from "./canonical.ts";
import { happyPathEvents, qaAcceptExample, qaWaitingExample, revisionTwo } from "./examples.ts";
import { requestKanbanMove, type KanbanMoveLedger } from "./kanbanMove.ts";
import { JIM_ACTOR_ID, REWORK_CAP_LABEL } from "./reworkCap.ts";
import {
  applySequence,
  applySequenceEvent,
  decodeSequenceState,
  kanbanColumn,
  type SequenceState,
} from "./sequence.ts";

const taskId = "task-usba-page";
const attemptId = "attempt-1";

const sha = (n: number) => ({ type: "git" as const, sha: n.toString(16).padStart(40, "0") });

const finding = (n: number) => ({
  defect: `Defect ${n}.`,
  evidence: `The preview still shows build ${n}.`,
  expectedBehavior: `The page matches build ${n}.`,
});

const completion = (generation: number, attempt: string, revision: number, summary: string) => ({
  version: "v1" as const,
  taskId,
  attemptId: attempt,
  generation,
  leaseId: leaseIdFor(generation),
  claimedOutcome: summary,
  artifactRevision: sha(revision),
  evidence: [{ kind: "commit" as const, ref: `commit-${revision}` }],
});

const rework = (attempt: string, revision: number, recommendation?: string) => ({
  version: "v1" as const,
  taskId,
  attemptId: attempt,
  availability: "available" as const,
  qaModel: "claude-sonnet-5",
  implementerModel: "gpt-5.4",
  verdict: "rework" as const,
  artifactRevision: sha(revision),
  findings: [finding(revision)],
  ...(recommendation === undefined ? {} : { recommendation }),
});

const roundsOf = (state: SequenceState): number =>
  "reworkLedger" in state ? state.reworkLedger.rounds.length : 0;

const count = (state: SequenceState, expected: number) => {
  assert.strictEqual(roundsOf(state), expected);
};

const failure = (state: SequenceState, event: unknown) =>
  Effect.flip(applySequenceEvent(state, event));

const submit = (state: SequenceState, attempt: string, revision: number, summary: string) => {
  if (state.phase !== "executing") {
    return Effect.die("A completion needs an executing run.");
  }
  return applySequenceEvent(state, {
    type: "submit_completion",
    completion: completion(state.run.generation, attempt, revision, summary),
  });
};

const verdict = (
  state: SequenceState,
  attempt: string,
  revision: number,
  recommendation?: string,
) => applySequenceEvent(state, { type: "qa", qa: rework(attempt, revision, recommendation) });

it.effect("stops the task after three rework verdicts", () =>
  Effect.gen(function* () {
    let state = yield* applySequence(happyPathEvents.slice(0, 4));
    count(state, 0);
    state = yield* submit(state, attemptId, 1, "Listed Saturday only.");
    const waiting = yield* applySequenceEvent(state, { type: "qa", qa: qaWaitingExample });
    assert.strictEqual(waiting.phase, "awaiting_qa");
    count(waiting, 0);

    state = yield* verdict(waiting, attemptId, 1);
    assert.strictEqual(state.phase, "rework");
    assert.strictEqual(kanbanColumn(state.phase), "Ready");
    count(state, 1);

    state = yield* applySequenceEvent(state, { type: "start_execution" });
    state = yield* submit(state, attemptId, 2, "Added Sunday, omitted the final.");
    state = yield* verdict(state, attemptId, 2);
    assert.strictEqual(state.phase, "rework");
    count(state, 2);

    state = yield* applySequenceEvent(state, { type: "start_execution" });
    state = yield* submit(state, attemptId, 3, "Added the final and dropped the venue.");
    const missing = yield* failure(state, { type: "qa", qa: rework(attemptId, 3) });
    assert.strictEqual(missing.reason, "rework_cap_needs_recommendation");
    assert.strictEqual(state.phase, "awaiting_qa");
    count(state, 2);

    const capped = yield* verdict(
      state,
      attemptId,
      3,
      "Stop and ask Jim. The venue field is still wrong after three fixes.",
    );
    if (capped.phase !== "rework_capped") {
      return yield* Effect.die("The third rework must block the task.");
    }
    count(capped, 3);
    assert.strictEqual(capped.notice.label, REWORK_CAP_LABEL);
    assert.strictEqual(kanbanColumn(capped.phase), "Blocked");
    assert.strictEqual(
      capped.notice.recommendation,
      "Stop and ask Jim. The venue field is still wrong after three fixes.",
    );
    assert.deepStrictEqual(capped.notice.remainingIssue, [finding(3)]);
    assert.deepStrictEqual(
      capped.notice.attemptedFixes.map((round) => ({
        round: round.round,
        summary: round.summary,
        commitSha: round.commitSha,
      })),
      [
        { round: 1, summary: "Listed Saturday only.", commitSha: sha(1).sha },
        { round: 2, summary: "Added Sunday, omitted the final.", commitSha: sha(2).sha },
        { round: 3, summary: "Added the final and dropped the venue.", commitSha: sha(3).sha },
      ],
    );
    assert.deepStrictEqual(capped.notice.attemptedFixes[2]?.findings, [finding(3)]);

    const dispatched = yield* failure(capped, { type: "start_execution" });
    assert.strictEqual(dispatched.reason, "rework_cap_reached");
    assert.strictEqual(capped.phase, "rework_capped");
    const move = yield* requestKanbanMove(capped, {
      taskId,
      column: "Running",
      idempotencyKey: "launch-capped",
      confirmed: true,
      at: "2026-10-22T12:00:00Z",
      ledger: {} as KanbanMoveLedger,
    });
    assert.strictEqual(move._tag, "Rejected");
    if (move._tag === "Rejected") {
      assert.strictEqual(move.detail.includes(REWORK_CAP_LABEL), true);
    }
    count(capped, 3);
  }),
);

it.effect("keeps the rework count across reload, recovery, retry, handoff, and a new attempt", () =>
  Effect.gen(function* () {
    let state = yield* applySequence(happyPathEvents.slice(0, 4));
    state = yield* submit(state, attemptId, 1, "Listed Saturday only.");
    state = yield* verdict(state, attemptId, 1);
    count(state, 1);

    state = yield* applySequenceEvent(state, { type: "start_execution" });
    if (state.phase !== "executing") return yield* Effect.die("Rework must start.");
    const handed = yield* applySequenceEvent(state, {
      type: "transfer_ownership",
      command: {
        command: "transfer_ownership",
        idempotencyKey: "handoff-1",
        taskId,
        attemptId,
        ownerId: "t3-other",
      },
    });
    count(handed, 1);
    if (handed.phase !== "executing") return yield* Effect.die("A handoff stays on the task.");
    assert.notStrictEqual(handed.run.generation, 1);

    const blocked = yield* applySequenceEvent(handed, {
      type: "lease_expired",
      lease: {
        taskId,
        attemptId,
        generation: handed.run.generation,
        leaseId: handed.run.leaseId,
      },
    });
    assert.strictEqual(blocked.phase, "recovery_pending");
    count(blocked, 1);
    const recovered = yield* applySequenceEvent(blocked, {
      type: "resolve_recovery",
      command: {
        command: "resolve_recovery",
        outcome: "continue",
        idempotencyKey: "recover-1",
        taskId,
        attemptId,
      },
    });
    assert.strictEqual(recovered.phase, "assigned");
    count(recovered, 1);

    const reattempted = yield* applySequenceEvent(recovered, {
      type: "open_attempt",
      command: {
        command: "open_attempt",
        idempotencyKey: "attempt-2",
        taskId,
        attemptId,
        nextAttemptId: "attempt-2",
      },
    });
    if (reattempted.phase !== "assigned") return yield* Effect.die("A new attempt stays assigned.");
    assert.strictEqual(reattempted.assignment.attemptId, "attempt-2");
    count(reattempted, 1);

    state = yield* applySequenceEvent(reattempted, { type: "start_execution" });
    if (state.phase !== "executing") return yield* Effect.die("The new attempt must start.");
    const failed = yield* applySequenceEvent(state, {
      type: "operator_fail",
      command: {
        command: "operator_fail",
        idempotencyKey: "fail-1",
        taskId,
        attemptId: "attempt-2",
        actorId: "t3-codex",
        blocker: {
          summary: "The run stopped.",
          ownerId: "t3-other",
          nextAction: "Retry the same task.",
        },
      },
    });
    count(failed, 1);
    const retried = yield* applySequenceEvent(failed, {
      type: "retry",
      command: {
        command: "retry",
        idempotencyKey: "retry-1",
        taskId,
        attemptId: "attempt-2",
      },
    });
    count(retried, 1);
    if (retried.phase !== "executing") return yield* Effect.die("Retry must execute.");
    assert.strictEqual(retried.run.retryCount, 1);

    state = yield* submit(retried, "attempt-2", 2, "Added Sunday, omitted the final.");
    state = yield* verdict(state, "attempt-2", 2);
    count(state, 2);

    const reloaded = yield* decodeSequenceState(JSON.parse(JSON.stringify(state)));
    count(reloaded, 2);
    if (reloaded.phase !== "rework") return yield* Effect.die("Reload must keep the rework phase.");
    assert.strictEqual(reloaded.assignment.attemptId, "attempt-2");
    assert.strictEqual(reloaded.reworkLedger.rounds[0]?.commitSha, sha(1).sha);
    assert.strictEqual(reloaded.reworkLedger.rounds[1]?.commitSha, sha(2).sha);

    state = yield* applySequenceEvent(reloaded, { type: "start_execution" });
    state = yield* submit(state, "attempt-2", 3, "Added the final and dropped the venue.");
    const capped = yield* verdict(state, "attempt-2", 3, "Ask Jim before another attempt.");
    assert.strictEqual(capped.phase, "rework_capped");
    count(capped, 3);
    if (capped.phase === "rework_capped") {
      assert.strictEqual(capped.assignment.attemptId, "attempt-2");
    }
  }),
);

it.effect("refuses an agent reset of the rework count", () =>
  Effect.gen(function* () {
    let state = yield* applySequence(happyPathEvents.slice(0, 4));
    state = yield* submit(state, attemptId, 1, "Listed Saturday only.");
    state = yield* verdict(state, attemptId, 1);
    state = yield* applySequenceEvent(state, { type: "start_execution" });
    state = yield* submit(state, attemptId, 2, "Added Sunday, omitted the final.");
    state = yield* verdict(state, attemptId, 2);
    state = yield* applySequenceEvent(state, { type: "start_execution" });
    state = yield* submit(state, attemptId, 3, "Added the final and dropped the venue.");
    const capped = yield* verdict(state, attemptId, 3, "Ask Jim.");
    count(capped, 3);

    const agentResume = yield* failure(capped, {
      type: "resume_rework",
      command: {
        command: "resume_rework",
        idempotencyKey: "agent-resume",
        taskId,
        attemptId,
        actorId: "t3-codex",
        decision: "Reset the counter and keep going.",
      },
    });
    assert.strictEqual(agentResume.reason, "rework_cap_reached");
    assert.strictEqual(capped.phase, "rework_capped");
    count(capped, 3);

    const wiped = yield* failure(capped, {
      type: "open_attempt",
      command: {
        command: "open_attempt",
        idempotencyKey: "wipe",
        taskId,
        attemptId,
        nextAttemptId: "attempt-9",
        rounds: [],
      },
    });
    assert.strictEqual(wiped.reason, "invalid_payload");
    count(capped, 3);

    const launched = yield* failure(capped, { type: "start_execution" });
    assert.strictEqual(launched.reason, "rework_cap_reached");
    const retried = yield* failure(capped, {
      type: "retry",
      command: { command: "retry", idempotencyKey: "retry-cap", taskId, attemptId },
    });
    assert.strictEqual(retried.reason, "rework_cap_reached");

    if (capped.phase !== "rework_capped") return yield* Effect.die("The cap must hold.");
    const { notice: _notice, ...withoutNotice } = capped;
    const forged = yield* Effect.exit(decodeSequenceState({ ...withoutNotice, phase: "rework" }));
    assert.strictEqual(Exit.isFailure(forged), true);
  }),
);

it.effect("records Jim's resume and does not clear the count", () =>
  Effect.gen(function* () {
    let state = yield* applySequence(happyPathEvents.slice(0, 4));
    state = yield* submit(state, attemptId, 1, "Listed Saturday only.");
    state = yield* verdict(state, attemptId, 1);
    state = yield* applySequenceEvent(state, { type: "start_execution" });
    state = yield* submit(state, attemptId, 2, "Added Sunday, omitted the final.");
    state = yield* verdict(state, attemptId, 2);
    state = yield* applySequenceEvent(state, { type: "start_execution" });
    state = yield* submit(state, attemptId, 3, "Added the final and dropped the venue.");
    const capped = yield* verdict(state, attemptId, 3, "Ask Jim.");
    const decision = "One more pass on the venue, then stop if QA still fails.";
    const resumed = yield* applySequenceEvent(capped, {
      type: "resume_rework",
      command: {
        command: "resume_rework",
        idempotencyKey: "jim-resume",
        taskId,
        attemptId,
        actorId: JIM_ACTOR_ID,
        decision,
      },
    });
    if (resumed.phase !== "rework")
      return yield* Effect.die("Jim's resume returns the task to rework.");
    count(resumed, 3);
    assert.strictEqual(resumed.reworkLedger.decisions[0]?.decision, decision);
    assert.strictEqual(resumed.reworkLedger.decisions[0]?.actorId, JIM_ACTOR_ID);
    assert.strictEqual(resumed.reworkLedger.decisions[0]?.reworkRounds, 3);
    assert.strictEqual(kanbanColumn(resumed.phase), "Ready");

    const replayed = yield* applySequenceEvent(resumed, {
      type: "resume_rework",
      command: {
        command: "resume_rework",
        idempotencyKey: "jim-resume",
        taskId,
        attemptId,
        actorId: JIM_ACTOR_ID,
        decision,
      },
    });
    if (replayed.phase !== "rework") return yield* Effect.die("A repeated resume replays.");
    assert.strictEqual(replayed.reworkLedger.decisions.length, 1);

    const started = yield* applySequenceEvent(resumed, { type: "start_execution" });
    assert.strictEqual(started.phase, "executing");
    count(started, 3);

    state = yield* submit(started, attemptId, 4, "Restored the venue name.");
    const again = yield* verdict(state, attemptId, 4, "The date line is still a day off.");
    if (again.phase !== "rework_capped") return yield* Effect.die("The next rework stops again.");
    count(again, 4);
    assert.strictEqual(again.reworkLedger.decisions.length, 1);
    assert.strictEqual(again.notice.attemptedFixes.length, 4);
    assert.strictEqual(again.notice.remainingIssue[0]?.defect, "Defect 4.");

    const second = yield* applySequenceEvent(again, {
      type: "resume_rework",
      command: {
        command: "resume_rework",
        idempotencyKey: "jim-resume-2",
        taskId,
        attemptId,
        actorId: JIM_ACTOR_ID,
        decision: "Leave the date line. I will edit it.",
      },
    });
    count(second, 4);
    if (second.phase !== "rework") return yield* Effect.die("Jim can resume again.");
    assert.strictEqual(second.reworkLedger.decisions.length, 2);
    assert.strictEqual(second.reworkLedger.rounds.length, 4);
  }),
);

it.effect("keeps earlier rework rounds when QA later accepts", () =>
  Effect.gen(function* () {
    let state = yield* applySequence(happyPathEvents.slice(0, 4));
    state = yield* submit(state, attemptId, 1, "Listed Saturday only.");
    state = yield* verdict(state, attemptId, 1);
    count(state, 1);
    state = yield* applySequenceEvent(state, { type: "start_execution" });
    if (state.phase !== "executing") return yield* Effect.die("Rework must start.");
    state = yield* applySequenceEvent(state, {
      type: "submit_completion",
      completion: {
        ...completion(state.run.generation, attemptId, 2, "Added Sunday."),
        artifactRevision: revisionTwo,
      },
    });
    const accepted = yield* applySequenceEvent(state, { type: "qa", qa: qaAcceptExample });
    assert.strictEqual(accepted.phase, "accepted");
    count(accepted, 1);
    const again = yield* applySequenceEvent(accepted, { type: "start_execution" });
    count(again, 1);
  }),
);
