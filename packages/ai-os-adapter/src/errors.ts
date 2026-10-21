import * as Schema from "effect/Schema";

export class GrokT3Error extends Schema.TaggedError<GrokT3Error>()("GrokT3Error", {
  reason: Schema.Literals([
    "unsupported",
    "invalid_task",
    "unknown_task",
    "idempotency_conflict",
    "stale_generation",
    "contract",
    "t3_unavailable",
    "t3_rejected",
    "not_started",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
