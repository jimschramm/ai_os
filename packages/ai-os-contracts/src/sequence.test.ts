import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  acknowledgmentExample,
  assignmentExample,
  completionExample,
  happyPathEvents,
  intakeExample,
  qaAcceptExample,
  qaReworkExample,
  qaWaitingExample,
} from "./examples.ts";
import {
  LEGAL_EVENTS,
  acceptedRevision,
  applySequence,
  applySequenceEvent,
  initialSequenceState,
  kanbanColumn,
  type SequenceEvent,
  type SequenceState,
} from "./sequence.ts";

const failure = (state: SequenceState, event: SequenceEvent) =>
  Effect.flip(applySequenceEvent(state, event));

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
    assert.strictEqual(state.acknowledgment?.taskLink, "ai-os://tasks/task-usba-page");
    assert.strictEqual(state.completion?.artifactRevision, "rev-2");
    assert.strictEqual(acceptedRevision(state), "rev-2");
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
    assert.strictEqual(requested.acknowledgment, null);
    assert.strictEqual(kanbanColumn(requested.phase), null);

    const acknowledged = yield* applySequenceEvent(requested, {
      type: "acknowledge",
      acknowledgment: acknowledgmentExample,
    });
    assert.strictEqual(acknowledged.phase, "acknowledged");
    assert.strictEqual(acknowledged.acknowledgment?.taskId, "task-usba-page");
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
    const repeated = yield* failure(executing, {
      type: "submit_completion",
      completion: completionExample,
    });
    assert.strictEqual(repeated.reason, "revision_mismatch");

    const corrected = yield* applySequence(happyPathEvents.slice(0, 9));
    if (qaAcceptExample.availability !== "available" || qaAcceptExample.verdict !== "accept") {
      return yield* Effect.die("The accept example must accept a revision.");
    }
    const stale = yield* failure(corrected, {
      type: "qa",
      qa: { ...qaAcceptExample, artifactRevision: "rev-1", acceptedRevision: "rev-1" },
    });
    assert.strictEqual(stale.reason, "acceptance_revision_mismatch");

    const accepted = yield* applySequenceEvent(corrected, { type: "qa", qa: qaAcceptExample });
    assert.strictEqual(acceptedRevision(accepted), "rev-2");
    const changedAgain = yield* applySequenceEvent(accepted, { type: "start_execution" });
    assert.strictEqual(changedAgain.phase, "executing");
    assert.strictEqual(acceptedRevision(changedAgain), null);
  }),
);

it.effect("blocks an expired lease as recovery_pending and does not return it to Ready", () =>
  Effect.gen(function* () {
    const executing = yield* applySequence(happyPathEvents.slice(0, 4));
    const blocked = yield* applySequenceEvent(executing, { type: "lease_expired" });
    assert.strictEqual(blocked.phase, "recovery_pending");
    assert.strictEqual(blocked.recoveryLabel, "Execution status unknown");
    assert.strictEqual(kanbanColumn(blocked.phase), "Blocked");

    const events: ReadonlyArray<SequenceEvent> = [
      { type: "intake", intake: intakeExample },
      { type: "acknowledge", acknowledgment: acknowledgmentExample },
      { type: "assign", assignment: assignmentExample },
      { type: "start_execution" },
      { type: "lease_expired" },
      { type: "submit_completion", completion: completionExample },
      { type: "qa", qa: qaAcceptExample },
    ];
    for (const event of events) {
      const error = yield* failure(blocked, event);
      assert.strictEqual(error.reason, "recovery_pending_not_ready");
    }
    assert.deepStrictEqual(LEGAL_EVENTS.recovery_pending, []);
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
