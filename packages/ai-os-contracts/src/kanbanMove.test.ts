import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { leaseIdFor } from "./canonical.ts";
import { assignmentExample, happyPathEvents, intakeExample, revisionOne } from "./examples.ts";
import {
  applyBoardWorkflowEvent,
  commitInterruptedMove,
  requestKanbanMove,
  type KanbanMoveLedger,
  type KanbanMoveResult,
} from "./kanbanMove.ts";
import { applySequence, kanbanColumn, type KanbanColumn, type SequenceState } from "./sequence.ts";

const at = "2026-10-22T12:00:00Z";
const empty: KanbanMoveLedger = {};

const phase = (state: SequenceState, name: SequenceState["phase"]): SequenceState => {
  if (state.phase !== name) {
    throw new Error(`expected ${name}, got ${state.phase}`);
  }
  return state;
};

const move = (
  state: SequenceState,
  column: KanbanColumn,
  key: string,
  confirmed = false,
  ledger: KanbanMoveLedger = empty,
) =>
  requestKanbanMove(state, {
    taskId: "task-usba-page",
    column,
    idempotencyKey: key,
    confirmed,
    at,
    ledger,
  });

const applied = (result: KanbanMoveResult): Extract<KanbanMoveResult, { _tag: "Applied" }> => {
  if (result._tag !== "Applied") {
    throw new Error("detail" in result ? result.detail : "not applied");
  }
  return result;
};

const generation = (state: SequenceState): number | null => {
  if (state.phase === "executing" || state.phase === "recovery_pending")
    return state.run.generation;
  if (state.phase === "assigned") return state.heldRun?.generation ?? null;
  return null;
};

it.effect("rejects every move that would skip QA on the way to Done", () =>
  Effect.gen(function* () {
    const requested = phase(yield* applySequence(happyPathEvents.slice(0, 1)), "requested");
    const acknowledged = phase(yield* applySequence(happyPathEvents.slice(0, 2)), "acknowledged");
    const assigned = phase(yield* applySequence(happyPathEvents.slice(0, 3)), "assigned");
    const executing = phase(yield* applySequence(happyPathEvents.slice(0, 4)), "executing");
    const awaiting = phase(yield* applySequence(happyPathEvents.slice(0, 5)), "awaiting_qa");
    const rework = phase(yield* applySequence(happyPathEvents.slice(0, 7)), "rework");
    const blocked = phase(
      yield* applyBoardWorkflowEvent(
        executing,
        {
          type: "lease_expired",
          lease: {
            taskId: assignmentExample.taskId,
            attemptId: assignmentExample.attemptId,
            generation: 1,
            leaseId: leaseIdFor(1),
          },
        },
        "lease-1",
        "task-usba-page",
        empty,
      ).pipe(
        Effect.map((result) => {
          if (result._tag !== "Applied") throw new Error(result.detail);
          return result.state;
        }),
      ),
      "recovery_pending",
    );
    const failed = phase(
      yield* applyBoardWorkflowEvent(
        executing,
        {
          type: "fail",
          failure: {
            taskId: assignmentExample.taskId,
            attemptId: assignmentExample.attemptId,
            generation: 1,
            leaseId: leaseIdFor(1),
            blocker: {
              summary: "The preview server is down.",
              ownerId: "t3-codex",
              nextAction: "Restart the preview, then retry.",
            },
          },
        },
        "fail-1",
        "task-usba-page",
        empty,
      ).pipe(
        Effect.map((result) => {
          if (result._tag !== "Applied") throw new Error(result.detail);
          return result.state;
        }),
      ),
      "failed",
    );
    const accepted = phase(yield* applySequence(happyPathEvents), "accepted");
    const sources = [
      requested,
      acknowledged,
      assigned,
      executing,
      awaiting,
      rework,
      blocked,
      failed,
      accepted,
    ];
    for (const source of sources) {
      const result = yield* move(source, "Done", `done-${source.phase}`, true);
      assert.strictEqual(result._tag, source.phase === "accepted" ? "Applied" : "Rejected");
      assert.strictEqual(result.state.phase, source.phase);
      if (result._tag === "Rejected") {
        assert.match(result.detail, /different model/);
      }
    }
  }),
);

it.effect("rejects the other illegal column moves and leaves the phase alone", () =>
  Effect.gen(function* () {
    const requested = phase(yield* applySequence(happyPathEvents.slice(0, 1)), "requested");
    const acknowledged = phase(yield* applySequence(happyPathEvents.slice(0, 2)), "acknowledged");
    const assigned = phase(yield* applySequence(happyPathEvents.slice(0, 3)), "assigned");
    const executing = phase(yield* applySequence(happyPathEvents.slice(0, 4)), "executing");
    const awaiting = phase(yield* applySequence(happyPathEvents.slice(0, 5)), "awaiting_qa");
    const rework = phase(yield* applySequence(happyPathEvents.slice(0, 7)), "rework");
    const blocked = phase(
      yield* applyBoardWorkflowEvent(
        executing,
        {
          type: "lease_expired",
          lease: {
            taskId: assignmentExample.taskId,
            attemptId: assignmentExample.attemptId,
            generation: 1,
            leaseId: leaseIdFor(1),
          },
        },
        "lease-blocked",
        "task-usba-page",
        empty,
      ).pipe(
        Effect.map((result) => {
          if (result._tag !== "Applied") throw new Error(result.detail);
          return result.state;
        }),
      ),
      "recovery_pending",
    );
    const forbidden: ReadonlyArray<readonly [SequenceState, KanbanColumn]> = [
      [requested, "Running"],
      [requested, "Review"],
      [requested, "Blocked"],
      [acknowledged, "Running"],
      [acknowledged, "Review"],
      [acknowledged, "Blocked"],
      [acknowledged, "Backlog"],
      [assigned, "Review"],
      [assigned, "Blocked"],
      [assigned, "Backlog"],
      [executing, "Review"],
      [executing, "Backlog"],
      [awaiting, "Running"],
      [awaiting, "Ready"],
      [awaiting, "Backlog"],
      [awaiting, "Blocked"],
      [rework, "Review"],
      [rework, "Blocked"],
      [rework, "Backlog"],
      [blocked, "Running"],
      [blocked, "Ready"],
      [blocked, "Review"],
      [blocked, "Backlog"],
    ];
    for (const [source, column] of forbidden) {
      const result = yield* move(source, column, `no-${source.phase}-${column}`, true);
      assert.notStrictEqual(result._tag, "Applied");
      assert.strictEqual(result.state.phase, source.phase);
      if (result._tag !== "Applied") assert.ok(result.detail.length > 0);
    }
  }),
);

it.effect("does not start a second run when the same drop is repeated", () =>
  Effect.gen(function* () {
    const assigned = phase(yield* applySequence(happyPathEvents.slice(0, 3)), "assigned");
    const fromBoard = yield* move(assigned, "Running", "start-1");
    assert.strictEqual(fromBoard._tag, "NeedsLaunch");
    assert.strictEqual(fromBoard.state.phase, "assigned");
    assert.deepStrictEqual(fromBoard.ledger, empty);
    if (fromBoard._tag === "NeedsLaunch") assert.match(fromBoard.detail, /confirmed active/);

    const rework = phase(yield* applySequence(happyPathEvents.slice(0, 7)), "rework");
    const reworkLaunch = yield* move(rework, "Running", "start-rework");
    assert.strictEqual(reworkLaunch._tag, "NeedsLaunch");
    assert.strictEqual(reworkLaunch.state.phase, "rework");
    assert.deepStrictEqual(reworkLaunch.ledger, empty);

    const first = applied(
      yield* applyBoardWorkflowEvent(
        assigned,
        { type: "start_execution" },
        "start-event",
        "task-usba-page",
        empty,
      ),
    );
    assert.strictEqual(first.state.phase, "executing");
    assert.strictEqual(generation(first.state), 1);

    const again = applied(yield* move(first.state, "Running", "start-2", false, first.ledger));
    assert.strictEqual(again.changed, false);
    assert.strictEqual(generation(again.state), 1);

    const duplicateEvent = applied(
      yield* applyBoardWorkflowEvent(
        first.state,
        { type: "start_execution" },
        "start-event-2",
        "task-usba-page",
        empty,
      ),
    );
    assert.strictEqual(duplicateEvent.changed, false);
    assert.strictEqual(generation(duplicateEvent.state), 1);
  }),
);

it.effect("refuses a silent cancel and uses the cancel path only after confirmation", () =>
  Effect.gen(function* () {
    const executing = phase(yield* applySequence(happyPathEvents.slice(0, 4)), "executing");
    const silent = yield* move(executing, "Ready", "cancel-1", false);
    assert.strictEqual(silent._tag, "NeedsConfirmation");
    assert.strictEqual(silent.state.phase, "executing");
    if (silent._tag === "NeedsConfirmation") assert.match(silent.detail, /Cancel this run/);

    const silentPause = yield* move(executing, "Blocked", "pause-1", false);
    assert.strictEqual(silentPause._tag, "NeedsConfirmation");
    assert.strictEqual(silentPause.state.phase, "executing");

    const confirmed = yield* move(executing, "Ready", "cancel-1", true);
    assert.strictEqual(confirmed._tag, "NeedsInterrupt");
    assert.strictEqual(confirmed.state.phase, "executing");
    if (confirmed._tag === "NeedsInterrupt") assert.strictEqual(confirmed.action, "cancel");
    assert.deepStrictEqual(confirmed.ledger, empty);

    const request = {
      taskId: "task-usba-page",
      column: "Ready" as const,
      idempotencyKey: "cancel-1",
      confirmed: true,
      at,
      ledger: confirmed.ledger,
    };
    const landed = applied(yield* commitInterruptedMove(executing, request));
    assert.strictEqual(landed.state.phase, "assigned");
    assert.strictEqual(kanbanColumn(landed.state.phase), "Ready");
    assert.strictEqual(generation(landed.state), 1);
    if (landed.state.phase === "assigned") {
      assert.strictEqual(
        landed.state.commands.some((command) => command.idempotencyKey === "cancel-1-c"),
        true,
      );
    }

    const repeated = applied(
      yield* commitInterruptedMove(executing, { ...request, ledger: landed.ledger }),
    );
    assert.strictEqual(repeated.changed, false);
    assert.strictEqual(repeated.state.phase, "assigned");
  }),
);

it.effect("queues a backlog card through acknowledge and pauses only through the lease", () =>
  Effect.gen(function* () {
    const requested = phase(
      yield* applySequence([{ type: "intake", intake: intakeExample }]),
      "requested",
    );
    assert.strictEqual(kanbanColumn(requested.phase), "Backlog");
    const queued = yield* move(requested, "Ready", "ack-1");
    assert.strictEqual(queued._tag, "Applied");
    assert.strictEqual(queued.state.phase, "acknowledged");

    const executing = phase(yield* applySequence(happyPathEvents.slice(0, 4)), "executing");
    const paused = yield* move(executing, "Blocked", "pause-2", true);
    assert.strictEqual(paused._tag, "NeedsInterrupt");
    assert.strictEqual(paused.state.phase, "executing");
    const landed = applied(
      yield* commitInterruptedMove(executing, {
        taskId: "task-usba-page",
        column: "Blocked",
        idempotencyKey: "pause-2",
        confirmed: true,
        at,
        ledger: paused.ledger,
      }),
    );
    assert.strictEqual(landed.state.phase, "recovery_pending");
    assert.strictEqual(kanbanColumn(landed.state.phase), "Blocked");
  }),
);

it.effect("keeps a completion claim from counting as acceptance", () =>
  Effect.gen(function* () {
    const executing = phase(yield* applySequence(happyPathEvents.slice(0, 4)), "executing");
    const submitted = yield* applyBoardWorkflowEvent(
      executing,
      {
        type: "submit_completion",
        completion: {
          version: "v1",
          taskId: assignmentExample.taskId,
          attemptId: assignmentExample.attemptId,
          generation: 1,
          leaseId: leaseIdFor(1),
          claimedOutcome: "Updated the tournament page.",
          artifactRevision: revisionOne,
          evidence: [{ kind: "diff", ref: "diff-rev-1" }],
        },
      },
      "submit-1",
      "task-usba-page",
      empty,
    );
    assert.strictEqual(submitted._tag, "Applied");
    assert.strictEqual(applied(submitted).state.phase, "awaiting_qa");
    const jumped = yield* move(applied(submitted).state, "Done", "skip-qa", true);
    assert.strictEqual(jumped._tag, "Rejected");
    assert.strictEqual(jumped.state.phase, "awaiting_qa");
  }),
);
