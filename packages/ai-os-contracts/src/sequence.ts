import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AssignmentV1, freezeSnapshot } from "./assignment.ts";
import { CompletionSubmissionV1 } from "./completion.ts";
import {
  ArtifactRevisionV1,
  sameModel,
  sameRevision,
  strictParse,
  taskLinkMatches,
} from "./common.ts";
import {
  ContractName,
  ContractTransitionError,
  RECOVERY_PENDING_LABEL,
  SequencePhase,
  type ContractErrorReason,
} from "./errors.ts";
import { IntakeAcknowledgmentV1, IntakeV1 } from "./intake.ts";
import { QaAcceptV1, QaReworkV1, QaUnavailableV1, QaVerdictV1 } from "./qa.ts";

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

const linked = (acknowledgment: IntakeAcknowledgmentV1): true | string =>
  taskLinkMatches(acknowledgment.taskId, acknowledgment.taskLink)
    ? true
    : "The task link must be ai-os://tasks/{taskId}.";

const assignedTo = (
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
): true | string => {
  const link = linked(acknowledgment);
  if (link !== true) {
    return link;
  }
  return assignment.taskId === acknowledgment.taskId
    ? true
    : "The assignment task must match the acknowledged task.";
};

const payloadMatches = (
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  payload: { readonly taskId: string; readonly attemptId: string },
): true | string => {
  const assignmentLink = assignedTo(acknowledgment, assignment);
  if (assignmentLink !== true) {
    return assignmentLink;
  }
  if (payload.taskId !== acknowledgment.taskId) {
    return "The payload task must match the acknowledged task.";
  }
  return payload.attemptId === assignment.attemptId
    ? true
    : "The payload attempt must match the assignment.";
};

const independentQa = (
  assignment: AssignmentV1,
  qa: { readonly qaModel: string; readonly implementerModel: string },
): true | string => {
  if (sameModel(qa.qaModel, assignment.implementerModel)) {
    return "QA must use a different model than the implementer.";
  }
  return sameModel(qa.implementerModel, assignment.implementerModel)
    ? true
    : "The QA payload names a different implementer than the assignment.";
};

const reviewedRevision = (
  completion: CompletionSubmissionV1,
  qa: { readonly artifactRevision: ArtifactRevisionV1 },
  reworkRevision: ArtifactRevisionV1 | null,
): true | string => {
  if (!sameRevision(completion.artifactRevision, qa.artifactRevision)) {
    return "QA is bound to the exact revision in the completion submission.";
  }
  if (reworkRevision !== null && sameRevision(qa.artifactRevision, reworkRevision)) {
    return "The revision sent back for rework is not the final revision.";
  }
  return true;
};

export const IdleState = Schema.Struct({
  phase: Schema.Literal("idle"),
});
export type IdleState = typeof IdleState.Type;

export const RequestedState = Schema.Struct({
  phase: Schema.Literal("requested"),
  intake: IntakeV1,
});
export type RequestedState = typeof RequestedState.Type;

export const AcknowledgedState = Schema.Struct({
  phase: Schema.Literal("acknowledged"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
}).check(Schema.makeFilter((state) => linked(state.acknowledgment)));
export type AcknowledgedState = typeof AcknowledgedState.Type;

export const AssignedState = Schema.Struct({
  phase: Schema.Literal("assigned"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type AssignedState = typeof AssignedState.Type;

export const ExecutingState = Schema.Struct({
  phase: Schema.Literal("executing"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type ExecutingState = typeof ExecutingState.Type;

export const AwaitingQaState = Schema.Struct({
  phase: Schema.Literal("awaiting_qa"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  completion: CompletionSubmissionV1,
  qa: Schema.NullOr(QaUnavailableV1),
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
}).check(
  Schema.makeFilter((state) => {
    const match = payloadMatches(state.acknowledgment, state.assignment, state.completion);
    if (match !== true) {
      return match;
    }
    if (state.qa !== null) {
      const qaMatch = payloadMatches(state.acknowledgment, state.assignment, state.qa);
      if (qaMatch !== true) {
        return qaMatch;
      }
    }
    if (
      state.reworkRevision !== null &&
      sameRevision(state.completion.artifactRevision, state.reworkRevision)
    ) {
      return "The submitted revision was already sent back for rework.";
    }
    return true;
  }),
);
export type AwaitingQaState = typeof AwaitingQaState.Type;

export const ReworkState = Schema.Struct({
  phase: Schema.Literal("rework"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  completion: CompletionSubmissionV1,
  qa: QaReworkV1,
  reworkRevision: ArtifactRevisionV1,
}).check(
  Schema.makeFilter((state) => {
    const match = payloadMatches(state.acknowledgment, state.assignment, state.completion);
    if (match !== true) {
      return match;
    }
    const qaMatch = payloadMatches(state.acknowledgment, state.assignment, state.qa);
    if (qaMatch !== true) {
      return qaMatch;
    }
    const models = independentQa(state.assignment, state.qa);
    if (models !== true) {
      return models;
    }
    if (!sameRevision(state.qa.artifactRevision, state.reworkRevision)) {
      return "Rework records the revision that was reviewed.";
    }
    return reviewedRevision(state.completion, state.qa, null);
  }),
);
export type ReworkState = typeof ReworkState.Type;

export const AcceptedState = Schema.Struct({
  phase: Schema.Literal("accepted"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  completion: CompletionSubmissionV1,
  qa: QaAcceptV1,
}).check(
  Schema.makeFilter((state) => {
    const match = payloadMatches(state.acknowledgment, state.assignment, state.completion);
    if (match !== true) {
      return match;
    }
    const qaMatch = payloadMatches(state.acknowledgment, state.assignment, state.qa);
    if (qaMatch !== true) {
      return qaMatch;
    }
    const models = independentQa(state.assignment, state.qa);
    if (models !== true) {
      return models;
    }
    if (!sameRevision(state.qa.acceptedRevision, state.qa.artifactRevision)) {
      return "Acceptance is bound to the exact artifact revision.";
    }
    return reviewedRevision(state.completion, state.qa, null);
  }),
);
export type AcceptedState = typeof AcceptedState.Type;

export const RecoveryPendingState = Schema.Struct({
  phase: Schema.Literal("recovery_pending"),
  intake: IntakeV1,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  recoveryLabel: Schema.Literal(RECOVERY_PENDING_LABEL),
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type RecoveryPendingState = typeof RecoveryPendingState.Type;

export const SequenceState = Schema.Union([
  IdleState,
  RequestedState,
  AcknowledgedState,
  AssignedState,
  ExecutingState,
  AwaitingQaState,
  ReworkState,
  AcceptedState,
  RecoveryPendingState,
]);
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

export const initialSequenceState: SequenceState = { phase: "idle" };

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

export const acceptedRevision = (state: SequenceState): ArtifactRevisionV1 | null =>
  state.phase === "accepted" ? state.qa.acceptedRevision : null;

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

const applyIntake = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "intake" }>,
): Effect.Effect<SequenceState, ContractTransitionError> => {
  if (state.phase !== "idle") {
    return reject(state, event, "illegal_transition", `Cannot intake from ${state.phase}.`);
  }
  return Effect.succeed({ phase: "requested", intake: event.intake });
};

const applyAcknowledge = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "acknowledge" }>,
): Effect.Effect<SequenceState, ContractTransitionError> => {
  if (state.phase !== "requested") {
    return reject(state, event, "illegal_transition", `Cannot acknowledge from ${state.phase}.`);
  }
  return Effect.succeed({
    phase: "acknowledged",
    intake: state.intake,
    acknowledgment: event.acknowledgment,
  });
};

const applyAssign = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "assign" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "acknowledged") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot assign from ${state.phase}.`,
      );
    }
    if (state.acknowledgment.taskId !== event.assignment.taskId) {
      return yield* reject(
        state,
        event,
        "task_mismatch",
        "The payload task does not match the acknowledged task.",
      );
    }
    return {
      phase: "assigned" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: freezeSnapshot(event.assignment),
    };
  });

const applyStart = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "start_execution" }>,
): Effect.Effect<SequenceState, ContractTransitionError> => {
  if (state.phase === "assigned" || state.phase === "accepted") {
    return Effect.succeed({
      phase: "executing",
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: null,
    });
  }
  if (state.phase === "rework") {
    return Effect.succeed({
      phase: "executing",
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
    });
  }
  return reject(state, event, "illegal_transition", `Cannot start_execution from ${state.phase}.`);
};

const applyLeaseExpired = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "lease_expired" }>,
): Effect.Effect<SequenceState, ContractTransitionError> => {
  if (state.phase !== "executing") {
    return reject(state, event, "illegal_transition", `Cannot lease_expired from ${state.phase}.`);
  }
  return Effect.succeed({
    phase: "recovery_pending",
    intake: state.intake,
    acknowledgment: state.acknowledgment,
    assignment: state.assignment,
    reworkRevision: state.reworkRevision,
    recoveryLabel: RECOVERY_PENDING_LABEL,
  });
};

const applyCompletion = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "submit_completion" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot submit_completion from ${state.phase}.`,
      );
    }
    if (state.acknowledgment.taskId !== event.completion.taskId) {
      return yield* reject(
        state,
        event,
        "task_mismatch",
        "The payload task does not match the acknowledged task.",
      );
    }
    if (state.assignment.attemptId !== event.completion.attemptId) {
      return yield* reject(
        state,
        event,
        "attempt_mismatch",
        "The payload attempt does not match the open assignment.",
      );
    }
    if (
      state.reworkRevision !== null &&
      sameRevision(event.completion.artifactRevision, state.reworkRevision)
    ) {
      return yield* reject(
        state,
        event,
        "revision_mismatch",
        "Rework must submit a new artifact revision.",
      );
    }
    return {
      phase: "awaiting_qa" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      completion: event.completion,
      qa: null,
      reworkRevision: state.reworkRevision,
    };
  });

const applyQa = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "qa" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "awaiting_qa") {
      return yield* reject(state, event, "illegal_transition", `Cannot qa from ${state.phase}.`);
    }
    const qa = event.qa;
    if (state.acknowledgment.taskId !== qa.taskId) {
      return yield* reject(
        state,
        event,
        "task_mismatch",
        "The payload task does not match the acknowledged task.",
      );
    }
    if (state.assignment.attemptId !== qa.attemptId) {
      return yield* reject(
        state,
        event,
        "attempt_mismatch",
        "The payload attempt does not match the open assignment.",
      );
    }
    if (qa.availability === "unavailable") {
      return {
        phase: "awaiting_qa" as const,
        intake: state.intake,
        acknowledgment: state.acknowledgment,
        assignment: state.assignment,
        completion: state.completion,
        qa,
        reworkRevision: state.reworkRevision,
      };
    }
    if (sameModel(qa.qaModel, state.assignment.implementerModel)) {
      return yield* reject(
        state,
        event,
        "qa_same_model",
        "QA must use a different model than the implementer.",
      );
    }
    if (!sameModel(qa.implementerModel, state.assignment.implementerModel)) {
      return yield* reject(
        state,
        event,
        "implementer_mismatch",
        "The QA payload names a different implementer than the assignment.",
      );
    }
    if (!sameRevision(qa.artifactRevision, state.completion.artifactRevision)) {
      return yield* reject(
        state,
        event,
        "acceptance_revision_mismatch",
        "QA is bound to the exact revision in the completion submission.",
      );
    }
    if (state.reworkRevision !== null && sameRevision(qa.artifactRevision, state.reworkRevision)) {
      return yield* reject(
        state,
        event,
        "acceptance_revision_mismatch",
        "The revision sent back for rework is not the final revision.",
      );
    }
    if (qa.verdict === "rework") {
      return {
        phase: "rework" as const,
        intake: state.intake,
        acknowledgment: state.acknowledgment,
        assignment: state.assignment,
        completion: state.completion,
        qa,
        reworkRevision: qa.artifactRevision,
      };
    }
    return {
      phase: "accepted" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      completion: state.completion,
      qa,
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
        return yield* applyStart(state, event);
      case "lease_expired":
        return yield* applyLeaseExpired(state, event);
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
