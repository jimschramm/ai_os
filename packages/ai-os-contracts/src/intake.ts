import * as Schema from "effect/Schema";

import { ConversationId } from "./canonical.ts";
import {
  ContractId,
  ContractText,
  ContractVersion,
  IsoDateTime,
  strictParse,
  TaskLink,
  taskLinkMatches,
} from "./common.ts";

export const AuthorizationV1 = Schema.Struct({
  kind: Schema.Literals(["standing", "explicit"]),
  scope: ContractText,
});
export type AuthorizationV1 = typeof AuthorizationV1.Type;

export const IntakeV1 = Schema.Struct({
  version: ContractVersion,
  workspaceId: ContractId,
  projectId: ContractId,
  request: ContractText,
  constraints: Schema.Array(ContractText),
  acceptanceCriteria: Schema.NonEmptyArray(ContractText),
  authorization: AuthorizationV1,
  originatingConversationId: ConversationId,
});
export type IntakeV1 = typeof IntakeV1.Type;

export const IntakeAcknowledgmentV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  taskLink: TaskLink,
  durable: Schema.Literal(true),
  receivedAt: IsoDateTime,
}).check(
  Schema.makeFilter((acknowledgment) =>
    taskLinkMatches(acknowledgment.taskId, acknowledgment.taskLink)
      ? true
      : "The task link must be ai-os://tasks/{taskId}.",
  ),
);
export type IntakeAcknowledgmentV1 = typeof IntakeAcknowledgmentV1.Type;

export const decodeIntakeV1 = Schema.decodeUnknownEffect(IntakeV1, strictParse);
export const decodeIntakeAcknowledgmentV1 = Schema.decodeUnknownEffect(
  IntakeAcknowledgmentV1,
  strictParse,
);
