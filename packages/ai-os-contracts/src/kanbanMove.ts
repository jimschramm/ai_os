import * as Effect from "effect/Effect";

import { taskLinkFor } from "./common.ts";
import { ContractTransitionError } from "./errors.ts";
import {
  applySequenceEvent,
  initialSequenceState,
  kanbanColumn,
  type KanbanColumn,
  type SequenceEvent,
  type SequenceState,
} from "./sequence.ts";

const DONE_REQUIRES_QA =
  "Done requires a passed independent QA from a different model than the builder. Moving a card here does not accept it.";

const RUNNING_FROM_BOARD =
  "In Progress starts when the adapter launches the run. The board does not mark it started.";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface KanbanMoveRecord {
  readonly column: KanbanColumn;
  readonly taskId: string;
  readonly state: SequenceState;
}

export type KanbanMoveLedger = Readonly<Record<string, KanbanMoveRecord>>;

export interface KanbanMoveRequest {
  readonly taskId: string;
  readonly column: KanbanColumn;
  readonly idempotencyKey: string;
  readonly confirmed: boolean;
  readonly at: string;
  readonly ledger: KanbanMoveLedger;
}

export type KanbanMoveResult =
  | {
      readonly _tag: "Applied";
      readonly state: SequenceState;
      readonly changed: boolean;
      readonly ledger: KanbanMoveLedger;
    }
  | {
      readonly _tag: "Rejected";
      readonly detail: string;
      readonly state: SequenceState;
      readonly ledger: KanbanMoveLedger;
    }
  | {
      readonly _tag: "NeedsConfirmation";
      readonly detail: string;
      readonly state: SequenceState;
      readonly ledger: KanbanMoveLedger;
    }
  | {
      readonly _tag: "NeedsInterrupt";
      readonly action: "cancel" | "pause";
      readonly detail: string;
      readonly state: SequenceState;
      readonly ledger: KanbanMoveLedger;
    };

const applied = (
  state: SequenceState,
  changed: boolean,
  ledger: KanbanMoveLedger,
): KanbanMoveResult => ({ _tag: "Applied", state, changed, ledger });

const rejected = (
  detail: string,
  state: SequenceState,
  ledger: KanbanMoveLedger,
): KanbanMoveResult => ({ _tag: "Rejected", detail, state, ledger });

const needsConfirmation = (
  detail: string,
  state: SequenceState,
  ledger: KanbanMoveLedger,
): KanbanMoveResult => ({ _tag: "NeedsConfirmation", detail, state, ledger });

const needsInterrupt = (
  action: "cancel" | "pause",
  detail: string,
  state: SequenceState,
  ledger: KanbanMoveLedger,
): KanbanMoveResult => ({ _tag: "NeedsInterrupt", action, detail, state, ledger });

const remember = (
  ledger: KanbanMoveLedger,
  key: string,
  column: KanbanColumn,
  taskId: string,
  state: SequenceState,
): KanbanMoveLedger => ({ ...ledger, [key]: { column, taskId, state } });

const validKey = (key: string): boolean => KEY.test(key) && key.length <= 110;

const replay = (request: KanbanMoveRequest, state: SequenceState): KanbanMoveResult | null => {
  const recorded = request.ledger[request.idempotencyKey];
  if (recorded === undefined) return null;
  if (recorded.taskId !== request.taskId || recorded.column !== request.column) {
    return rejected(
      "This idempotency key was already used for a different move.",
      state,
      request.ledger,
    );
  }
  if (kanbanColumn(state.phase) === request.column) {
    return applied(state, false, request.ledger);
  }
  return applied(recorded.state, false, request.ledger);
};

const fold = (
  state: SequenceState,
  events: readonly SequenceEvent[],
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    let current = state;
    for (const event of events) {
      current = yield* applySequenceEvent(current, event);
    }
    return current;
  });

const commit = (
  request: KanbanMoveRequest,
  state: SequenceState,
  events: readonly SequenceEvent[],
): Effect.Effect<KanbanMoveResult> =>
  fold(state, events).pipe(
    Effect.map((next) =>
      applied(
        next,
        true,
        remember(request.ledger, request.idempotencyKey, request.column, request.taskId, next),
      ),
    ),
    Effect.catchTags({
      ContractTransitionError: (error) =>
        Effect.succeed(rejected(error.detail, state, request.ledger)),
    }),
  );

const workIds = (
  state: SequenceState & {
    readonly acknowledgment: { readonly taskId: string };
    readonly assignment: { readonly attemptId: string };
  },
) => ({ taskId: state.acknowledgment.taskId, attemptId: state.assignment.attemptId });

/**
 * Ask the sequence machine to enter a column. The returned state is whatever
 * the machine produced. Callers persist that state and never assign a phase.
 */
export const requestKanbanMove = (
  state: SequenceState,
  request: KanbanMoveRequest,
): Effect.Effect<KanbanMoveResult> => {
  if (!validKey(request.idempotencyKey) || !KEY.test(request.taskId)) {
    return Effect.succeed(
      rejected("The task id or idempotency key is not a contract id.", state, request.ledger),
    );
  }
  const seen = replay(request, state);
  if (seen !== null) return Effect.succeed(seen);

  const current = kanbanColumn(state.phase);
  if (current === request.column) {
    return Effect.succeed(
      applied(
        state,
        false,
        remember(request.ledger, request.idempotencyKey, request.column, request.taskId, state),
      ),
    );
  }

  if (state.phase === "executing") {
    if (request.column === "Done") {
      return Effect.succeed(rejected(DONE_REQUIRES_QA, state, request.ledger));
    }
    if (request.column === "Review") {
      return Effect.succeed(
        rejected(
          "In QA needs a completion submission from the run. The board does not invent one.",
          state,
          request.ledger,
        ),
      );
    }
    if (request.column === "Backlog") {
      return Effect.succeed(
        rejected(
          "Active work cannot return to Backlog. Cancel it back to Ready, or pause it to Blocked.",
          state,
          request.ledger,
        ),
      );
    }
    if (request.column === "Ready" || request.column === "Blocked") {
      if (!request.confirmed) {
        const detail =
          request.column === "Ready"
            ? "Cancel this run and return it to Ready? The workflow records a cancel, then queues the same attempt again. It does not start a second run."
            : "Pause this run? The workflow records the open lease as expired and blocks the card until someone resolves it.";
        return Effect.succeed(needsConfirmation(detail, state, request.ledger));
      }
      // The ledger stays untouched until the caller has interrupted the run.
      return Effect.succeed(
        needsInterrupt(
          request.column === "Ready" ? "cancel" : "pause",
          request.column === "Ready"
            ? "Cancel waits until the run confirms the interrupt."
            : "Pause waits until the run confirms the interrupt.",
          state,
          request.ledger,
        ),
      );
    }
  }

  if (request.column === "Done") {
    return Effect.succeed(rejected(DONE_REQUIRES_QA, state, request.ledger));
  }

  if (request.column === "Running") {
    return Effect.succeed(rejected(RUNNING_FROM_BOARD, state, request.ledger));
  }

  if (request.column === "Ready" && state.phase === "requested") {
    return commit(request, state, [
      {
        type: "acknowledge",
        acknowledgment: {
          version: "v1",
          taskId: request.taskId,
          taskLink: taskLinkFor(request.taskId),
          durable: true,
          receivedAt: request.at,
        },
      },
    ]);
  }

  if (state.phase === "idle" || state.phase === "cancelled" || current === null) {
    return Effect.succeed(rejected("This task is not on a column.", state, request.ledger));
  }

  return Effect.succeed(
    rejected(
      `The workflow cannot move this task from ${current} to ${request.column}.`,
      state,
      request.ledger,
    ),
  );
};

/**
 * Record cancel or pause only after the caller has interrupted the live run.
 * A repeat of the same key returns the recorded state and does not append again.
 */
export const commitInterruptedMove = (
  state: SequenceState,
  request: KanbanMoveRequest,
): Effect.Effect<KanbanMoveResult> => {
  if (!validKey(request.idempotencyKey) || !KEY.test(request.taskId)) {
    return Effect.succeed(
      rejected("The task id or idempotency key is not a contract id.", state, request.ledger),
    );
  }
  const seen = replay(request, state);
  if (seen !== null) return Effect.succeed(seen);
  if (state.phase !== "executing") {
    return Effect.succeed(
      rejected(
        "The run is no longer active, so the card was left as it is.",
        state,
        request.ledger,
      ),
    );
  }
  const ids = workIds(state);
  if (request.column === "Blocked") {
    return commit(request, state, [
      {
        type: "lease_expired",
        lease: {
          ...ids,
          generation: state.run.generation,
          leaseId: state.run.leaseId,
        },
      },
    ]);
  }
  if (request.column === "Ready") {
    return commit(request, state, [
      {
        type: "cancel",
        command: {
          command: "cancel",
          ...ids,
          idempotencyKey: `${request.idempotencyKey}-c`,
        },
      },
      {
        type: "continue",
        command: {
          command: "continue",
          ...ids,
          idempotencyKey: `${request.idempotencyKey}-k`,
        },
      },
    ]);
  }
  return Effect.succeed(
    rejected("This confirmation is not a cancel or a pause.", state, request.ledger),
  );
};

/**
 * Apply one orchestration event. A repeated start while the run is already
 * open returns the same state instead of opening another generation.
 */
export const applyBoardWorkflowEvent = (
  state: SequenceState,
  event: SequenceEvent,
  idempotencyKey: string,
  taskId: string,
  ledger: KanbanMoveLedger,
): Effect.Effect<KanbanMoveResult> =>
  Effect.gen(function* () {
    if (!validKey(idempotencyKey)) {
      return rejected("The idempotency key is not a contract id.", state, ledger);
    }
    const recorded = ledger[idempotencyKey];
    if (recorded !== undefined) {
      if (recorded.taskId !== taskId) {
        return rejected(
          "This idempotency key was already used for a different task.",
          state,
          ledger,
        );
      }
      return applied(state.phase === recorded.state.phase ? state : recorded.state, false, ledger);
    }
    if (event.type === "start_execution" && state.phase === "executing") {
      const column = kanbanColumn(state.phase);
      if (column === null) return rejected("This task is not on a column.", state, ledger);
      return applied(state, false, remember(ledger, idempotencyKey, column, taskId, state));
    }
    return yield* applySequenceEvent(state, event).pipe(
      Effect.map((next) => {
        const column = kanbanColumn(next.phase);
        const nextLedger =
          column === null ? ledger : remember(ledger, idempotencyKey, column, taskId, next);
        return applied(next, true, nextLedger);
      }),
      Effect.catchTags({
        ContractTransitionError: (error) => Effect.succeed(rejected(error.detail, state, ledger)),
      }),
    );
  });

export const openBoardTask = (
  event: SequenceEvent,
  idempotencyKey: string,
  taskId: string,
  ledger: KanbanMoveLedger,
): Effect.Effect<KanbanMoveResult> => {
  if (event.type !== "intake") {
    return Effect.succeed(
      rejected("Intake is the only way to open a task.", initialSequenceState, ledger),
    );
  }
  return applyBoardWorkflowEvent(initialSequenceState, event, idempotencyKey, taskId, ledger);
};
