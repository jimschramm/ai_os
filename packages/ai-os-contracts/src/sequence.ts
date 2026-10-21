import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AssignmentV1 } from "./assignment.ts";
import { CompletionSubmissionV1 } from "./completion.ts";
import { Revision, strictParse } from "./common.ts";
import {
  ContractName,
  ContractTransitionError,
  RECOVERY_PENDING_LABEL,
  SequencePhase,
  type ContractErrorReason,
} from "./errors.ts";
import { IntakeAcknowledgmentV1, IntakeV1 } from "./intake.ts";
import { QaVerdictV1 } from "./qa.ts";

export const KanbanColumn = Schema.Literals(["Ready", "Running", "Blocked", "Review", "Done"]);
export type KanbanColumn = typeof KanbanColumn.Type;

export const SequenceEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("intake"), intake: IntakeV1 }),
  Schema.Struct({
    type: Schema.Literal("acknowledge"),
    acknowledgment: IntakeAcknowledgmentV1,
  }),
  Schema.Struct({ type: Schema.Literal("assign"), assignment: AssignmentV1 }),
  Schema.Struct({ type: Schema.Literal("start_execution") }),
  Schema.Struct({ type: Schema.Literal("lease_expired") }),
  Schema.Struct({
    type: Schema.Literal("submit_completion"),
    completion: CompletionSubmissionV1,
  }),
  Schema.Struct({ type: Schema.Literal("qa"), qa: QaVerdictV1 }),
]);
export type SequenceEvent = typeof SequenceEvent.Type;

export const SequenceState = Schema.Struct({
  phase: SequencePhase,
  intake: Schema.NullOr(IntakeV1),
  acknowledgment: Schema.NullOr(IntakeAcknowledgmentV1),
  assignment: Schema.NullOr(AssignmentV1),
  completion: Schema.NullOr(CompletionSubmissionV1),
  qa: Schema.NullOr(QaVerdictV1),
  reworkRevision: Schema.NullOr(Revision),
  recoveryLabel: Schema.NullOr(Schema.Literal(RECOVERY_PENDING_LABEL)),
});
export type SequenceState = typeof SequenceState.Type;

export const LEGAL_EVENTS = {
  idle: ["intake"],
  requested: ["acknowledge"],
  acknowledged: ["assign"],
  assigned: ["start_execution"],
  executing: ["submit_completion", "lease_expired"],
  awaiting_qa: ["qa"],
  rework: ["start_execution"],
  accepted: ["start_execution"],
  recovery_pending: [],
} as const satisfies Record<SequencePhase, ReadonlyArray<SequenceEvent["type"]>>;

export const initialSequenceState: SequenceState = {
  phase: "idle",
  intake: null,
  acknowledgment: null,
  assignment: null,
  completion: null,
  qa: null,
  reworkRevision: null,
  recoveryLabel: null,
};

export const kanbanColumn = (phase: SequencePhase): KanbanColumn | null => {
  switch (phase) {
    case "idle":
    case "requested":
      return null;
    case "acknowledged":
    case "assigned":
    case "rework":
      return "Ready";
    case "executing":
      return "Running";
    case "recovery_pending":
      return "Blocked";
    case "awaiting_qa":
      return "Review";
    case "accepted":
      return "Done";
  }
};

export const acceptedRevision = (state: SequenceState): string | null =>
  state.phase === "accepted" &&
  state.qa !== null &&
  state.qa.availability === "available" &&
  state.qa.verdict === "accept"
    ? state.qa.acceptedRevision
    : null;

const contractFor = (event: SequenceEvent): ContractName => {
  switch (event.type) {
    case "intake":
    case "acknowledge":
      return "intake";
    case "assign":
      return "assignment";
    case "submit_completion":
      return "completion";
    case "qa":
      return "qa";
    case "start_execution":
    case "lease_expired":
      return "sequence";
  }
};

const reject = (
  state: SequenceState,
  event: SequenceEvent,
  reason: ContractErrorReason,
  detail: string,
): Effect.Effect<never, ContractTransitionError> =>
  Effect.fail(
    new ContractTransitionError({
      contract: contractFor(event),
      reason,
      from: state.phase,
      event: event.type,
      detail,
    }),
  );

const isLegalEvent = (phase: SequencePhase, eventType: SequenceEvent["type"]): boolean =>
  (LEGAL_EVENTS[phase] as ReadonlyArray<SequenceEvent["type"]>).includes(eventType);

const requireLink = (
  state: SequenceState,
  event: SequenceEvent,
  taskId: string,
  attemptId: string | null,
) =>
  Effect.gen(function* () {
    if (state.acknowledgment === null || state.acknowledgment.taskId !== taskId) {
      return yield* reject(
        state,
        event,
        "task_mismatch",
        "The payload task does not match the acknowledged task.",
      );
    }
    if (
      attemptId !== null &&
      (state.assignment === null || state.assignment.attemptId !== attemptId)
    ) {
      return yield* reject(
        state,
        event,
        "attempt_mismatch",
        "The payload attempt does not match the open assignment.",
      );
    }
    return state.acknowledgment.taskId;
  });

const applyIntake = (state: SequenceState, event: Extract<SequenceEvent, { type: "intake" }>) =>
  Effect.succeed<SequenceState>({
    ...initialSequenceState,
    phase: "requested",
    intake: event.intake,
  });

const applyAcknowledge = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "acknowledge" }>,
) =>
  Effect.succeed<SequenceState>({
    ...state,
    phase: "acknowledged",
    acknowledgment: event.acknowledgment,
  });

const applyAssign = (state: SequenceState, event: Extract<SequenceEvent, { type: "assign" }>) =>
  Effect.gen(function* () {
    yield* requireLink(state, event, event.assignment.taskId, null);
    return {
      ...state,
      phase: "assigned" as const,
      assignment: event.assignment,
      completion: null,
      qa: null,
      reworkRevision: null,
      recoveryLabel: null,
    };
  });

const applyStart = (state: SequenceState) => {
  if (state.phase === "accepted") {
    return Effect.succeed<SequenceState>({
      ...state,
      phase: "executing",
      completion: null,
      qa: null,
      reworkRevision: null,
      recoveryLabel: null,
    });
  }
  if (state.phase === "rework") {
    return Effect.succeed<SequenceState>({
      ...state,
      phase: "executing",
      completion: null,
      qa: null,
      recoveryLabel: null,
    });
  }
  return Effect.succeed<SequenceState>({
    ...state,
    phase: "executing",
    recoveryLabel: null,
  });
};

const applyLeaseExpired = (state: SequenceState) =>
  Effect.succeed<SequenceState>({
    ...state,
    phase: "recovery_pending",
    recoveryLabel: RECOVERY_PENDING_LABEL,
  });

const applyCompletion = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "submit_completion" }>,
) =>
  Effect.gen(function* () {
    yield* requireLink(state, event, event.completion.taskId, event.completion.attemptId);
    if (
      state.reworkRevision !== null &&
      event.completion.artifactRevision === state.reworkRevision
    ) {
      return yield* reject(
        state,
        event,
        "revision_mismatch",
        "Rework must submit a new artifact revision.",
      );
    }
    return {
      ...state,
      phase: "awaiting_qa" as const,
      completion: event.completion,
      qa: null,
      recoveryLabel: null,
    };
  });

const applyQa = (state: SequenceState, event: Extract<SequenceEvent, { type: "qa" }>) =>
  Effect.gen(function* () {
    const qa = event.qa;
    yield* requireLink(state, event, qa.taskId, qa.attemptId);
    if (qa.availability === "unavailable") {
      return {
        ...state,
        phase: "awaiting_qa" as const,
        qa,
        recoveryLabel: null,
      };
    }
    if (state.assignment === null || state.completion === null) {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        "QA requires an assignment and a completion submission.",
      );
    }
    if (qa.qaModel === state.assignment.implementerModel) {
      return yield* reject(
        state,
        event,
        "qa_same_model",
        "QA must use a different model than the implementer.",
      );
    }
    if (qa.implementerModel !== state.assignment.implementerModel) {
      return yield* reject(
        state,
        event,
        "implementer_mismatch",
        "The QA payload names a different implementer than the assignment.",
      );
    }
    if (qa.artifactRevision !== state.completion.artifactRevision) {
      return yield* reject(
        state,
        event,
        "acceptance_revision_mismatch",
        "QA is bound to the exact revision in the completion submission.",
      );
    }
    if (state.reworkRevision !== null && qa.artifactRevision === state.reworkRevision) {
      return yield* reject(
        state,
        event,
        "acceptance_revision_mismatch",
        "The revision sent back for rework is not the final revision.",
      );
    }
    if (qa.verdict === "rework") {
      return {
        ...state,
        phase: "rework" as const,
        qa,
        reworkRevision: qa.artifactRevision,
        recoveryLabel: null,
      };
    }
    return {
      ...state,
      phase: "accepted" as const,
      qa,
      recoveryLabel: null,
    };
  });

export const applySequenceEvent = (
  state: SequenceState,
  event: SequenceEvent,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase === "recovery_pending") {
      return yield* reject(
        state,
        event,
        "recovery_pending_not_ready",
        `${RECOVERY_PENDING_LABEL}. An expired lease does not return to Ready.`,
      );
    }
    if (event.type === "acknowledge" && state.phase === "idle") {
      return yield* reject(
        state,
        event,
        "confirmation_before_durable_receipt",
        "Confirmation requires a durable receipt of the request.",
      );
    }
    if (!isLegalEvent(state.phase, event.type)) {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot ${event.type} from ${state.phase}.`,
      );
    }
    switch (event.type) {
      case "intake":
        return yield* applyIntake(state, event);
      case "acknowledge":
        return yield* applyAcknowledge(state, event);
      case "assign":
        return yield* applyAssign(state, event);
      case "start_execution":
        return yield* applyStart(state);
      case "lease_expired":
        return yield* applyLeaseExpired(state);
      case "submit_completion":
        return yield* applyCompletion(state, event);
      case "qa":
        return yield* applyQa(state, event);
    }
  });

export const applySequence = (
  events: ReadonlyArray<SequenceEvent>,
  start: SequenceState = initialSequenceState,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  events.reduce<Effect.Effect<SequenceState, ContractTransitionError>>(
    (step, event) => Effect.flatMap(step, (state) => applySequenceEvent(state, event)),
    Effect.succeed(start),
  );

export const decodeSequenceEvent = Schema.decodeUnknownEffect(SequenceEvent, strictParse);
export const decodeSequenceState = Schema.decodeUnknownEffect(SequenceState, strictParse);
