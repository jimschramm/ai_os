import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AdvisoryReviewV1 } from "./advisory.ts";
import { AssignmentV1, declaredTaskType, freezeSnapshot } from "./assignment.ts";
import { CompletionSubmissionV1 } from "./completion.ts";
import {
  AppliedCommandV1,
  CancelCommandV1,
  ContinueCommandV1,
  type ControlCommandV1,
  DEFAULT_RETRY_LIMIT,
  OperatorFailCommandV1,
  ResolveRecoveryCommandV1,
  RetryCommandV1,
  TransferOwnershipCommandV1,
  commandFingerprint,
  rememberCommand,
} from "./control.ts";
import { leaseIdFor } from "./canonical.ts";
import {
  ArtifactRevisionV1,
  ContractId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ModelRef,
  canonicalGitSha,
  sameBaseModel,
  sameModelName,
  sameRevision,
  strictParse,
  taskLinkMatches,
} from "./common.ts";
import { DeliveryAckV1, ResultDeliveryV1, ackFor, deliveryFingerprint } from "./delivery.ts";
import {
  ContractName,
  ContractTransitionError,
  RECOVERY_PENDING_LABEL,
  REVIEW_DELIVERED_LABEL,
  SequencePhase,
  type ContractErrorReason,
} from "./errors.ts";
import { Intake, IntakeAcknowledgmentV1 } from "./intake.ts";
import {
  BlockerV1,
  HeartbeatLapseV1,
  HeartbeatV1,
  LeaseExpiredV1,
  ProgressReportV1,
  WorkerFailV1,
} from "./progress.ts";
import { QaAcceptV1, QaReworkV1, QaUnavailableV1, QaVerdictV1 } from "./qa.ts";
import { UsageMeasurementV1 } from "./usage.ts";

export const KanbanColumn = Schema.Literals([
  "Backlog",
  "Ready",
  "Running",
  "Blocked",
  "Review",
  "Done",
]);
export type KanbanColumn = typeof KanbanColumn.Type;

export const SequenceEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("intake"), intake: Intake }),
  Schema.Struct({
    type: Schema.Literal("acknowledge"),
    acknowledgment: IntakeAcknowledgmentV1,
  }),
  Schema.Struct({ type: Schema.Literal("assign"), assignment: AssignmentV1 }),
  Schema.Struct({ type: Schema.Literal("start_execution") }),
  Schema.Struct({ type: Schema.Literal("lease_expired"), lease: LeaseExpiredV1 }),
  Schema.Struct({
    type: Schema.Literal("submit_completion"),
    completion: CompletionSubmissionV1,
  }),
  Schema.Struct({ type: Schema.Literal("qa"), qa: QaVerdictV1 }),
  Schema.Struct({ type: Schema.Literal("report_progress"), report: ProgressReportV1 }),
  Schema.Struct({ type: Schema.Literal("heartbeat"), heartbeat: HeartbeatV1 }),
  Schema.Struct({ type: Schema.Literal("heartbeat_lapsed"), lapse: HeartbeatLapseV1 }),
  Schema.Struct({
    type: Schema.Literal("report_usage"),
    generation: PositiveInt,
    leaseId: ContractId,
    measurement: UsageMeasurementV1,
  }),
  Schema.Struct({ type: Schema.Literal("record_advisory"), review: AdvisoryReviewV1 }),
  Schema.Struct({
    type: Schema.Literal("deliver_review"),
    generation: PositiveInt,
    leaseId: ContractId,
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), command: CancelCommandV1 }),
  Schema.Struct({ type: Schema.Literal("continue"), command: ContinueCommandV1 }),
  Schema.Struct({ type: Schema.Literal("retry"), command: RetryCommandV1 }),
  Schema.Struct({
    type: Schema.Literal("transfer_ownership"),
    command: TransferOwnershipCommandV1,
  }),
  Schema.Struct({ type: Schema.Literal("fail"), failure: WorkerFailV1 }),
  Schema.Struct({ type: Schema.Literal("operator_fail"), command: OperatorFailCommandV1 }),
  Schema.Struct({ type: Schema.Literal("resolve_recovery"), command: ResolveRecoveryCommandV1 }),
  Schema.Struct({ type: Schema.Literal("deliver"), delivery: ResultDeliveryV1 }),
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

const modelThatRan = (
  assignment: AssignmentV1,
  run: { readonly executedModel?: ModelRef | undefined },
): ModelRef | string => run.executedModel ?? assignment.implementerModel;

const independentQa = (
  ran: ModelRef | string,
  qa: { readonly qaModel: ModelRef | string; readonly implementerModel: ModelRef | string },
): true | string => {
  if (sameBaseModel(qa.qaModel, ran)) {
    return "QA must use a different base model than the model that ran.";
  }
  return sameModelName(qa.implementerModel, ran)
    ? true
    : "The QA payload names a different implementer than the model that ran.";
};

const workerRecordMatchesRun = (
  run: { readonly generation: number; readonly leaseId: string },
  record: { readonly generation: number; readonly leaseId: string },
): true | string =>
  record.generation === run.generation && record.leaseId === run.leaseId
    ? true
    : "Stored worker data must name the current generation and lease.";

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
  intake: Intake,
});
export type RequestedState = typeof RequestedState.Type;

export const AcknowledgedState = Schema.Struct({
  phase: Schema.Literal("acknowledged"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
}).check(Schema.makeFilter((state) => linked(state.acknowledgment)));
export type AcknowledgedState = typeof AcknowledgedState.Type;

export const RunV1 = Schema.Struct({
  generation: PositiveInt,
  leaseId: ContractId,
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  progress: Schema.NullOr(ProgressReportV1),
  retryCount: NonNegativeInt,
  retryLimit: PositiveInt,
  usage: Schema.Array(UsageMeasurementV1),
  // Absent on runs recorded before advisory review existed.
  advisory: Schema.optionalKey(AdvisoryReviewV1),
  // Set from usage when the worker reports the model that ran. QA uses it.
  executedModel: Schema.optionalKey(ModelRef),
}).check(
  Schema.makeFilter((run) => {
    if (run.retryCount > run.retryLimit) {
      return "The retry count is above the limit.";
    }
    if (run.leaseId !== leaseIdFor(run.generation)) {
      return "The lease is bound to the generation.";
    }
    if (run.progress !== null) {
      const progress = workerRecordMatchesRun(run, run.progress);
      if (progress !== true) return progress;
    }
    if (run.advisory !== undefined) {
      const advisory = workerRecordMatchesRun(run, run.advisory);
      if (advisory !== true) return advisory;
    }
    return true;
  }),
);
export type RunV1 = typeof RunV1.Type;

const freshRun = (generation: number, previous?: RunV1): RunV1 => ({
  generation,
  leaseId: leaseIdFor(generation),
  leaseExpiresAt: null,
  progress: null,
  retryCount: previous?.retryCount ?? 0,
  retryLimit: previous?.retryLimit ?? DEFAULT_RETRY_LIMIT,
  usage: previous?.usage ?? [],
});

export const AssignedState = Schema.Struct({
  phase: Schema.Literal("assigned"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  heldRun: Schema.NullOr(RunV1),
  commands: Schema.Array(AppliedCommandV1),
  nextGeneration: PositiveInt,
}).check(
  Schema.makeFilter((state) => {
    const link = assignedTo(state.acknowledgment, state.assignment);
    if (link !== true) {
      return link;
    }
    if (state.heldRun !== null && state.nextGeneration !== state.heldRun.generation + 1) {
      return "The next generation must follow the held run.";
    }
    return true;
  }),
);
export type AssignedState = typeof AssignedState.Type;

export const ExecutingState = Schema.Struct({
  phase: Schema.Literal("executing"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type ExecutingState = typeof ExecutingState.Type;

export const AwaitingQaState = Schema.Struct({
  phase: Schema.Literal("awaiting_qa"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  completion: CompletionSubmissionV1,
  qa: Schema.NullOr(QaUnavailableV1),
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
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
    return workerRecordMatchesRun(state.run, state.completion);
  }),
);
export type AwaitingQaState = typeof AwaitingQaState.Type;

export const ReworkState = Schema.Struct({
  phase: Schema.Literal("rework"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  completion: CompletionSubmissionV1,
  qa: QaReworkV1,
  reworkRevision: ArtifactRevisionV1,
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
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
    const models = independentQa(modelThatRan(state.assignment, state.run), state.qa);
    if (models !== true) {
      return models;
    }
    if (!sameRevision(state.qa.artifactRevision, state.reworkRevision)) {
      return "Rework records the revision that was reviewed.";
    }
    const current = workerRecordMatchesRun(state.run, state.completion);
    return current === true ? reviewedRevision(state.completion, state.qa, null) : current;
  }),
);
export type ReworkState = typeof ReworkState.Type;

export const AcceptedState = Schema.Struct({
  phase: Schema.Literal("accepted"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  completion: CompletionSubmissionV1,
  qa: QaAcceptV1,
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
  deliveries: Schema.Array(DeliveryAckV1),
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
    const models = independentQa(modelThatRan(state.assignment, state.run), state.qa);
    if (models !== true) {
      return models;
    }
    if (!sameRevision(state.qa.acceptedRevision, state.qa.artifactRevision)) {
      return "Acceptance is bound to the exact artifact revision.";
    }
    const current = workerRecordMatchesRun(state.run, state.completion);
    return current === true ? reviewedRevision(state.completion, state.qa, null) : current;
  }),
);
export type AcceptedState = typeof AcceptedState.Type;

export const ReviewDeliveredState = Schema.Struct({
  phase: Schema.Literal("review_delivered"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reviewLabel: Schema.Literal(REVIEW_DELIVERED_LABEL),
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
}).check(
  Schema.makeFilter((state) => {
    const link = assignedTo(state.acknowledgment, state.assignment);
    if (link !== true) return link;
    if (declaredTaskType(state.assignment) !== "advisory") {
      return "Only an advisory task finishes as a delivered review.";
    }
    if (state.run.advisory === undefined) {
      return "A delivered review keeps its findings on the run.";
    }
    const reviewed = canonicalGitSha(state.run.advisory.commit);
    const assigned = canonicalGitSha(state.assignment.contextPackage.repoCommit);
    return reviewed !== null && reviewed === assigned
      ? true
      : "The delivered review is bound to the assigned revision.";
  }),
);
export type ReviewDeliveredState = typeof ReviewDeliveredState.Type;

export const RecoveryPendingState = Schema.Struct({
  phase: Schema.Literal("recovery_pending"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  recoveryLabel: Schema.Literal(RECOVERY_PENDING_LABEL),
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type RecoveryPendingState = typeof RecoveryPendingState.Type;

export const FailedState = Schema.Struct({
  phase: Schema.Literal("failed"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  run: RunV1,
  commands: Schema.Array(AppliedCommandV1),
  blocker: BlockerV1,
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type FailedState = typeof FailedState.Type;

export const CancelledState = Schema.Struct({
  phase: Schema.Literal("cancelled"),
  intake: Intake,
  acknowledgment: IntakeAcknowledgmentV1,
  assignment: AssignmentV1,
  reworkRevision: Schema.NullOr(ArtifactRevisionV1),
  run: Schema.NullOr(RunV1),
  commands: Schema.Array(AppliedCommandV1),
  nextGeneration: PositiveInt,
}).check(Schema.makeFilter((state) => assignedTo(state.acknowledgment, state.assignment)));
export type CancelledState = typeof CancelledState.Type;

export const SequenceState = Schema.Union([
  IdleState,
  RequestedState,
  AcknowledgedState,
  AssignedState,
  ExecutingState,
  AwaitingQaState,
  ReworkState,
  AcceptedState,
  ReviewDeliveredState,
  RecoveryPendingState,
  FailedState,
  CancelledState,
]);
export type SequenceState = typeof SequenceState.Type;

export const LEGAL_EVENTS = {
  idle: ["intake"],
  requested: ["acknowledge"],
  acknowledged: ["assign"],
  assigned: ["start_execution", "cancel", "transfer_ownership"],
  executing: [
    "submit_completion",
    "lease_expired",
    "report_progress",
    "heartbeat",
    "heartbeat_lapsed",
    "report_usage",
    "record_advisory",
    "deliver_review",
    "cancel",
    "fail",
    "operator_fail",
    "transfer_ownership",
  ],
  awaiting_qa: ["qa", "cancel"],
  rework: ["start_execution", "cancel"],
  accepted: ["start_execution", "deliver"],
  review_delivered: [],
  recovery_pending: ["resolve_recovery"],
  failed: ["retry"],
  cancelled: ["continue"],
} as const satisfies Record<SequencePhase, ReadonlyArray<SequenceEvent["type"]>>;

export const initialSequenceState: SequenceState = { phase: "idle" };

export const kanbanColumn = (phase: SequencePhase): KanbanColumn | null => {
  switch (phase) {
    case "idle":
    case "cancelled":
      return null;
    case "requested":
      return "Backlog";
    case "acknowledged":
    case "assigned":
    case "rework":
      return "Ready";
    case "executing":
      return "Running";
    case "recovery_pending":
    case "failed":
      return "Blocked";
    case "awaiting_qa":
      return "Review";
    case "accepted":
    case "review_delivered":
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
    case "report_progress":
    case "heartbeat":
    case "heartbeat_lapsed":
      return "progress";
    case "report_usage":
      return "usage";
    case "record_advisory":
    case "deliver_review":
      return "sequence";
    case "cancel":
    case "continue":
    case "retry":
    case "transfer_ownership":
    case "operator_fail":
    case "resolve_recovery":
      return "control";
    case "deliver":
      return "delivery";
    case "start_execution":
    case "lease_expired":
    case "fail":
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
      reworkRevision: null,
      heldRun: null,
      commands: [],
      nextGeneration: 1,
    };
  });

const applyStart = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "start_execution" }>,
): Effect.Effect<SequenceState, ContractTransitionError> => {
  if (state.phase === "assigned") {
    return Effect.succeed({
      phase: "executing",
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: freshRun(state.nextGeneration, state.heldRun ?? undefined),
      commands: state.commands,
    });
  }
  if (state.phase === "accepted") {
    return Effect.succeed({
      phase: "executing",
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: null,
      run: freshRun(state.run.generation + 1, state.run),
      commands: state.commands,
    });
  }
  if (state.phase === "rework") {
    return Effect.succeed({
      phase: "executing",
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: freshRun(state.run.generation + 1, state.run),
      commands: state.commands,
    });
  }
  return reject(state, event, "illegal_transition", `Cannot start_execution from ${state.phase}.`);
};

const applyLeaseExpired = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "lease_expired" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot lease_expired from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.lease);
    yield* requireLease(state, event, event.lease);
    return {
      phase: "recovery_pending" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      recoveryLabel: RECOVERY_PENDING_LABEL,
      run: state.run,
      commands: state.commands,
    };
  });

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
    if (declaredTaskType(state.assignment) === "advisory") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        "An advisory review does not enter QA. It is delivered with the revision it reviewed.",
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
    yield* requireLease(state, event, event.completion);
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
      run: state.run,
      commands: state.commands,
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
    if (workerRecordMatchesRun(state.run, state.completion) !== true) {
      return yield* reject(
        state,
        event,
        "stale_generation",
        "QA is bound to the completion from the current run.",
      );
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
        run: state.run,
        commands: state.commands,
      };
    }
    const ran = modelThatRan(state.assignment, state.run);
    const independence = independentQa(ran, qa);
    if (independence !== true) {
      return yield* reject(
        state,
        event,
        sameBaseModel(qa.qaModel, ran) ? "qa_same_model" : "implementer_mismatch",
        independence,
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
        run: state.run,
        commands: state.commands,
      };
    }
    return {
      phase: "accepted" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      completion: state.completion,
      qa,
      run: state.run,
      commands: state.commands,
      deliveries: [],
    };
  });

const controlCommandOf = (event: SequenceEvent): ControlCommandV1 | null => {
  switch (event.type) {
    case "cancel":
    case "continue":
    case "retry":
    case "transfer_ownership":
    case "operator_fail":
    case "resolve_recovery":
      return event.command;
    default:
      return null;
  }
};

const replayControl = (
  state: SequenceState,
  event: SequenceEvent,
): Effect.Effect<SequenceState | null, ContractTransitionError> => {
  const command = controlCommandOf(event);
  if (command === null || !("commands" in state)) {
    return Effect.succeed(null);
  }
  const fingerprint = commandFingerprint(command);
  const existing = state.commands.find((entry) => entry.idempotencyKey === command.idempotencyKey);
  if (existing === undefined) {
    return Effect.succeed(null);
  }
  if (existing.fingerprint !== fingerprint) {
    return reject(
      state,
      event,
      "idempotency_conflict",
      "This idempotency key was already used for a different command.",
    );
  }
  return Effect.succeed(state);
};

const withCommand = (
  state: SequenceState & { readonly commands: ReadonlyArray<AppliedCommandV1> },
  event: SequenceEvent,
  command: ControlCommandV1,
): Effect.Effect<ReadonlyArray<AppliedCommandV1>, ContractTransitionError> =>
  Effect.map(
    rememberCommand(
      state.commands,
      command.idempotencyKey,
      commandFingerprint(command),
      state.phase,
      event.type,
    ),
    (recorded) => recorded.commands,
  );

const matchesWork = (
  state: SequenceState & {
    readonly acknowledgment: IntakeAcknowledgmentV1;
    readonly assignment: AssignmentV1;
  },
  event: SequenceEvent,
  payload: { readonly taskId: string; readonly attemptId: string },
): Effect.Effect<void, ContractTransitionError> =>
  Effect.gen(function* () {
    if (payload.taskId !== state.acknowledgment.taskId) {
      return yield* reject(
        state,
        event,
        "task_mismatch",
        "The payload task does not match the acknowledged task.",
      );
    }
    if (payload.attemptId !== state.assignment.attemptId) {
      return yield* reject(
        state,
        event,
        "attempt_mismatch",
        "The payload attempt does not match the open assignment.",
      );
    }
  });

const requireLease = (
  state: ExecutingState,
  event: SequenceEvent,
  fence: { readonly generation: number; readonly leaseId: string },
): Effect.Effect<void, ContractTransitionError> =>
  fence.generation === state.run.generation && fence.leaseId === state.run.leaseId
    ? Effect.void
    : reject(state, event, "stale_generation", "The write names a stale generation or lease.");

const applyProgress = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "report_progress" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot report_progress from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.report);
    yield* requireLease(state, event, event.report);
    return {
      ...state,
      run: { ...state.run, progress: event.report },
    };
  });

const applyHeartbeat = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "heartbeat" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot heartbeat from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.heartbeat);
    yield* requireLease(state, event, event.heartbeat);
    return {
      ...state,
      run: { ...state.run, leaseExpiresAt: event.heartbeat.leaseExpiresAt },
    };
  });

const applyHeartbeatLapse = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "heartbeat_lapsed" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot heartbeat_lapsed from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.lapse);
    yield* requireLease(state, event, event.lapse);
    return {
      phase: "recovery_pending" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      recoveryLabel: RECOVERY_PENDING_LABEL,
      run: state.run,
      commands: state.commands,
    };
  });

const applyUsage = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "report_usage" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot report_usage from ${state.phase}.`,
      );
    }
    if (event.measurement.attribution.projectId !== state.intake.projectId) {
      return yield* reject(
        state,
        event,
        "task_mismatch",
        "The usage project must match the intake project.",
      );
    }
    yield* matchesWork(state, event, event.measurement.attribution);
    yield* requireLease(state, event, event);
    return {
      ...state,
      run: {
        ...state.run,
        usage: [...state.run.usage, event.measurement],
        executedModel: event.measurement.attribution.model,
      },
    };
  });

const applyAdvisory = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "record_advisory" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot record_advisory from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.review);
    yield* requireLease(state, event, event.review);
    const reviewed = canonicalGitSha(event.review.commit);
    const assigned = canonicalGitSha(state.assignment.contextPackage.repoCommit);
    if (reviewed === null || reviewed !== assigned) {
      return yield* reject(
        state,
        event,
        "revision_mismatch",
        "The review is bound to the context package commit.",
      );
    }
    // Findings stay on the run. They do not become the QA verdict.
    return {
      ...state,
      run: { ...state.run, advisory: event.review },
    };
  });

const applyDeliverReview = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "deliver_review" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot deliver_review from ${state.phase}.`,
      );
    }
    if (declaredTaskType(state.assignment) !== "advisory") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        "Only an advisory task is delivered as a review. An implementation submits a completion for QA.",
      );
    }
    yield* requireLease(state, event, event);
    if (state.run.advisory === undefined) {
      return yield* reject(
        state,
        event,
        "invalid_payload",
        "A review is delivered only after its findings are recorded.",
      );
    }
    const reviewed = canonicalGitSha(state.run.advisory.commit);
    const assigned = canonicalGitSha(state.assignment.contextPackage.repoCommit);
    if (reviewed === null || reviewed !== assigned) {
      return yield* reject(
        state,
        event,
        "revision_mismatch",
        "The delivered review is bound to the assigned revision.",
      );
    }
    return {
      phase: "review_delivered" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reviewLabel: REVIEW_DELIVERED_LABEL,
      run: state.run,
      commands: state.commands,
    };
  });

const applyCancel = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "cancel" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (
      state.phase !== "assigned" &&
      state.phase !== "executing" &&
      state.phase !== "awaiting_qa" &&
      state.phase !== "rework"
    ) {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot cancel from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.command);
    const commands = yield* withCommand(state, event, event.command);
    if (state.phase === "assigned") {
      return {
        phase: "cancelled" as const,
        intake: state.intake,
        acknowledgment: state.acknowledgment,
        assignment: state.assignment,
        reworkRevision: state.reworkRevision,
        run: state.heldRun,
        commands,
        nextGeneration: state.nextGeneration,
      };
    }
    return {
      phase: "cancelled" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: state.run,
      commands,
      nextGeneration: state.run.generation + 1,
    };
  });

const applyContinue = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "continue" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "cancelled") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot continue from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.command);
    const commands = yield* withCommand(state, event, event.command);
    return {
      phase: "assigned" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      heldRun: state.run,
      commands,
      nextGeneration: state.nextGeneration,
    };
  });

const applyRetry = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "retry" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "failed") {
      return yield* reject(state, event, "illegal_transition", `Cannot retry from ${state.phase}.`);
    }
    yield* matchesWork(state, event, event.command);
    if (state.run.retryCount >= state.run.retryLimit) {
      return yield* reject(
        state,
        event,
        "retry_limit_reached",
        "The retry count has reached the limit.",
      );
    }
    const commands = yield* withCommand(state, event, event.command);
    return {
      phase: "executing" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: freshRun(state.run.generation + 1, {
        ...state.run,
        retryCount: state.run.retryCount + 1,
      }),
      commands,
    };
  });

const applyTransfer = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "transfer_ownership" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "assigned" && state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot transfer_ownership from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.command);
    const commands = yield* withCommand(state, event, event.command);
    const assignment = freezeSnapshot({ ...state.assignment, workerId: event.command.ownerId });
    if (state.phase === "assigned") {
      return { ...state, assignment, commands };
    }
    return {
      ...state,
      assignment,
      commands,
      run: freshRun(state.run.generation + 1, state.run),
    };
  });

const applyFail = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "fail" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(state, event, "illegal_transition", `Cannot fail from ${state.phase}.`);
    }
    yield* matchesWork(state, event, event.failure);
    yield* requireLease(state, event, event.failure);
    return {
      phase: "failed" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: state.run,
      commands: state.commands,
      blocker: event.failure.blocker,
    };
  });

const applyOperatorFail = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "operator_fail" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "executing") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot operator_fail from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.command);
    const commands = yield* withCommand(state, event, event.command);
    return {
      phase: "failed" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: state.run,
      commands,
      blocker: event.command.blocker,
    };
  });

const applyResolveRecovery = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "resolve_recovery" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "recovery_pending") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot resolve_recovery from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.command);
    const commands = yield* withCommand(state, event, event.command);
    if (event.command.outcome === "continue") {
      return {
        phase: "assigned" as const,
        intake: state.intake,
        acknowledgment: state.acknowledgment,
        assignment: state.assignment,
        reworkRevision: state.reworkRevision,
        heldRun: state.run,
        commands,
        nextGeneration: state.run.generation + 1,
      };
    }
    if (event.command.outcome === "cancel") {
      return {
        phase: "cancelled" as const,
        intake: state.intake,
        acknowledgment: state.acknowledgment,
        assignment: state.assignment,
        reworkRevision: state.reworkRevision,
        run: state.run,
        commands,
        nextGeneration: state.run.generation + 1,
      };
    }
    return {
      phase: "failed" as const,
      intake: state.intake,
      acknowledgment: state.acknowledgment,
      assignment: state.assignment,
      reworkRevision: state.reworkRevision,
      run: state.run,
      commands,
      blocker: event.command.blocker,
    };
  });

const applyDeliver = (
  state: SequenceState,
  event: Extract<SequenceEvent, { type: "deliver" }>,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    if (state.phase !== "accepted") {
      return yield* reject(
        state,
        event,
        "illegal_transition",
        `Cannot deliver from ${state.phase}.`,
      );
    }
    yield* matchesWork(state, event, event.delivery);
    if (
      !sameRevision(event.delivery.acceptedRevision, state.qa.acceptedRevision) ||
      !sameRevision(event.delivery.acceptedRevision, state.completion.artifactRevision)
    ) {
      return yield* reject(
        state,
        event,
        "delivery_revision_mismatch",
        "Delivery is bound to the exact accepted revision.",
      );
    }
    if (event.delivery.destination === "conversation") {
      if (!("originatingConversationId" in state.intake)) {
        return yield* reject(
          state,
          event,
          "delivery_origin_mismatch",
          "A v1 intake has no originating conversation. Deliver to the dashboard.",
        );
      }
      if (event.delivery.conversationId !== state.intake.originatingConversationId) {
        return yield* reject(
          state,
          event,
          "delivery_origin_mismatch",
          "Delivery to a conversation must name the originating conversation.",
        );
      }
    }
    const fingerprint = deliveryFingerprint(event.delivery);
    const sameKey = state.deliveries.find(
      (delivery) => delivery.idempotencyKey === event.delivery.idempotencyKey,
    );
    if (sameKey !== undefined) {
      if (sameKey.fingerprint === fingerprint) {
        return state;
      }
      return yield* reject(
        state,
        event,
        "idempotency_conflict",
        "This idempotency key was already used for a different delivery.",
      );
    }
    if (state.deliveries.some((delivery) => delivery.destination === event.delivery.destination)) {
      return state;
    }
    return { ...state, deliveries: [...state.deliveries, ackFor(event.delivery)] };
  });

const transition = (
  state: SequenceState,
  event: SequenceEvent,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    const replay = yield* replayControl(state, event);
    if (replay !== null) {
      return replay;
    }
    if (state.phase === "recovery_pending" && event.type !== "resolve_recovery") {
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
      case "report_progress":
        return yield* applyProgress(state, event);
      case "heartbeat":
        return yield* applyHeartbeat(state, event);
      case "heartbeat_lapsed":
        return yield* applyHeartbeatLapse(state, event);
      case "report_usage":
        return yield* applyUsage(state, event);
      case "record_advisory":
        return yield* applyAdvisory(state, event);
      case "deliver_review":
        return yield* applyDeliverReview(state, event);
      case "cancel":
        return yield* applyCancel(state, event);
      case "continue":
        return yield* applyContinue(state, event);
      case "retry":
        return yield* applyRetry(state, event);
      case "transfer_ownership":
        return yield* applyTransfer(state, event);
      case "fail":
        return yield* applyFail(state, event);
      case "operator_fail":
        return yield* applyOperatorFail(state, event);
      case "resolve_recovery":
        return yield* applyResolveRecovery(state, event);
      case "deliver":
        return yield* applyDeliver(state, event);
    }
  });

const PHASES = [
  "idle",
  "requested",
  "acknowledged",
  "assigned",
  "executing",
  "awaiting_qa",
  "rework",
  "accepted",
  "review_delivered",
  "recovery_pending",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<SequencePhase>;

const phaseOf = (value: unknown): SequencePhase => {
  if (typeof value === "object" && value !== null && "phase" in value) {
    const phase = value.phase;
    if (typeof phase === "string" && (PHASES as ReadonlyArray<string>).includes(phase)) {
      return phase as SequencePhase;
    }
  }
  return "idle";
};

const eventTypeOf = (value: unknown): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  ) {
    return value.type;
  }
  return "unknown";
};

const contractNameOf = (value: unknown): ContractName => {
  switch (eventTypeOf(value)) {
    case "intake":
    case "acknowledge":
      return "intake";
    case "assign":
      return "assignment";
    case "submit_completion":
      return "completion";
    case "qa":
      return "qa";
    case "report_progress":
    case "heartbeat":
    case "heartbeat_lapsed":
      return "progress";
    case "report_usage":
      return "usage";
    case "record_advisory":
    case "deliver_review":
      return "sequence";
    case "cancel":
    case "continue":
    case "retry":
    case "transfer_ownership":
    case "operator_fail":
    case "resolve_recovery":
      return "control";
    case "fail":
      return "sequence";
    case "deliver":
      return "delivery";
    default:
      return "sequence";
  }
};

const invalidPayload = (state: unknown, event: unknown, detail: string) =>
  new ContractTransitionError({
    contract: contractNameOf(event),
    reason: "invalid_payload",
    from: phaseOf(state),
    event: eventTypeOf(event),
    detail,
  });

export const decodeSequenceEvent = Schema.decodeUnknownEffect(SequenceEvent, strictParse);
export const decodeSequenceState = Schema.decodeUnknownEffect(SequenceState, strictParse);

export const applySequenceEvent = (
  state: unknown,
  event: unknown,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    const decodedState = yield* decodeSequenceState(state).pipe(
      Effect.mapError(() =>
        invalidPayload(state, event, "The sequence state does not match its phase."),
      ),
    );
    const decodedEvent = yield* decodeSequenceEvent(event).pipe(
      Effect.mapError(() =>
        invalidPayload(state, event, "The event does not match the contract schema."),
      ),
    );
    const next = yield* transition(decodedState, decodedEvent);
    return yield* decodeSequenceState(next).pipe(
      Effect.mapError(() =>
        invalidPayload(decodedState, decodedEvent, "The resulting state does not match its phase."),
      ),
    );
  });

export const applySequence = (
  events: ReadonlyArray<unknown>,
  start: unknown = initialSequenceState,
): Effect.Effect<SequenceState, ContractTransitionError> =>
  Effect.gen(function* () {
    const decodedStart = yield* decodeSequenceState(start).pipe(
      Effect.mapError(() =>
        invalidPayload(start, { type: "unknown" }, "The sequence state does not match its phase."),
      ),
    );
    return yield* events.reduce<Effect.Effect<SequenceState, ContractTransitionError>>(
      (step, event) => Effect.flatMap(step, (state) => applySequenceEvent(state, event)),
      Effect.succeed(decodedStart),
    );
  });
