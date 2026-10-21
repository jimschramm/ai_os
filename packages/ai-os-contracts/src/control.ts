import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ContractId, strictParse } from "./common.ts";
import { ContractTransitionError, type ContractErrorReason, type SequencePhase } from "./errors.ts";
import { BlockerV1 } from "./progress.ts";

export const DEFAULT_RETRY_LIMIT = 3;

export const AppliedCommandV1 = Schema.Struct({
  idempotencyKey: ContractId,
  command: ContractId,
});
export type AppliedCommandV1 = typeof AppliedCommandV1.Type;

const controlFields = {
  idempotencyKey: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
};

export const CancelCommandV1 = Schema.Struct({
  command: Schema.Literal("cancel"),
  ...controlFields,
});
export type CancelCommandV1 = typeof CancelCommandV1.Type;

export const ContinueCommandV1 = Schema.Struct({
  command: Schema.Literal("continue"),
  ...controlFields,
});
export type ContinueCommandV1 = typeof ContinueCommandV1.Type;

export const RetryCommandV1 = Schema.Struct({
  command: Schema.Literal("retry"),
  ...controlFields,
});
export type RetryCommandV1 = typeof RetryCommandV1.Type;

export const TransferOwnershipCommandV1 = Schema.Struct({
  command: Schema.Literal("transfer_ownership"),
  ...controlFields,
  ownerId: ContractId,
});
export type TransferOwnershipCommandV1 = typeof TransferOwnershipCommandV1.Type;

export const FailCommandV1 = Schema.Struct({
  command: Schema.Literal("fail"),
  ...controlFields,
  blocker: BlockerV1,
});
export type FailCommandV1 = typeof FailCommandV1.Type;

export const ResolveRecoveryCommandV1 = Schema.Union([
  Schema.Struct({
    command: Schema.Literal("resolve_recovery"),
    outcome: Schema.Literal("continue"),
    ...controlFields,
  }),
  Schema.Struct({
    command: Schema.Literal("resolve_recovery"),
    outcome: Schema.Literal("cancel"),
    ...controlFields,
  }),
  Schema.Struct({
    command: Schema.Literal("resolve_recovery"),
    outcome: Schema.Literal("fail"),
    ...controlFields,
    blocker: BlockerV1,
  }),
]);
export type ResolveRecoveryCommandV1 = typeof ResolveRecoveryCommandV1.Type;

export const ControlCommandV1 = Schema.Union([
  CancelCommandV1,
  ContinueCommandV1,
  RetryCommandV1,
  TransferOwnershipCommandV1,
  FailCommandV1,
  ResolveRecoveryCommandV1,
]);
export type ControlCommandV1 = typeof ControlCommandV1.Type;

export const commandName = (command: ControlCommandV1): string =>
  command.command === "resolve_recovery" ? `resolve_recovery:${command.outcome}` : command.command;

export const rememberCommand = (
  commands: ReadonlyArray<AppliedCommandV1>,
  idempotencyKey: string,
  command: string,
  phase: SequencePhase,
  event: string,
): Effect.Effect<
  { readonly commands: ReadonlyArray<AppliedCommandV1>; readonly replay: boolean },
  ContractTransitionError
> => {
  const existing = commands.find((entry) => entry.idempotencyKey === idempotencyKey);
  if (existing === undefined) {
    return Effect.succeed({
      commands: [...commands, { idempotencyKey, command }],
      replay: false,
    });
  }
  if (existing.command === command) {
    return Effect.succeed({ commands, replay: true });
  }
  return Effect.fail(
    new ContractTransitionError({
      contract: "control",
      reason: "idempotency_conflict" satisfies ContractErrorReason,
      from: phase,
      event,
      detail: "This idempotency key was already used for a different command.",
    }),
  );
};

export const decodeControlCommandV1 = Schema.decodeUnknownEffect(ControlCommandV1, strictParse);
