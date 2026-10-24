import * as Schema from "effect/Schema";

export const ContractName = Schema.Literals([
  "intake",
  "assignment",
  "completion",
  "qa",
  "sequence",
  "progress",
  "memory",
  "usage",
  "control",
  "delivery",
]);
export type ContractName = typeof ContractName.Type;

export const SequencePhase = Schema.Literals([
  "idle",
  "requested",
  "acknowledged",
  "assigned",
  "executing",
  "awaiting_qa",
  "rework",
  "rework_capped",
  "accepted",
  "recovery_pending",
  "failed",
  "cancelled",
]);
export type SequencePhase = typeof SequencePhase.Type;

export const ContractErrorReason = Schema.Literals([
  "illegal_transition",
  "confirmation_before_durable_receipt",
  "task_mismatch",
  "attempt_mismatch",
  "implementer_mismatch",
  "qa_same_model",
  "acceptance_revision_mismatch",
  "revision_mismatch",
  "recovery_pending_not_ready",
  "invalid_payload",
  "stale_generation",
  "retry_limit_reached",
  "rework_cap_reached",
  "rework_cap_needs_recommendation",
  "idempotency_conflict",
  "delivery_revision_mismatch",
  "delivery_origin_mismatch",
  "memory_not_eligible",
  "invalid_graph",
]);
export type ContractErrorReason = typeof ContractErrorReason.Type;

export const RECOVERY_PENDING_LABEL = "Execution status unknown";

export class ContractTransitionError extends Schema.TaggedError<ContractTransitionError>()(
  "ContractTransitionError",
  {
    contract: ContractName,
    reason: ContractErrorReason,
    from: SequencePhase,
    event: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
