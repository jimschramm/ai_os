import * as Schema from "effect/Schema";

import { ContractId, ContractText, ContractVersion, Revision, strictParse } from "./common.ts";

export const EvidenceKindV1 = Schema.Literals([
  "diff",
  "commit",
  "test",
  "browser",
  "preview",
  "deployment",
  "readback",
]);
export type EvidenceKindV1 = typeof EvidenceKindV1.Type;

export const EvidenceV1 = Schema.Struct({
  kind: EvidenceKindV1,
  ref: Revision,
});
export type EvidenceV1 = typeof EvidenceV1.Type;

export const CompletionSubmissionV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  claimedOutcome: ContractText,
  artifactRevision: Revision,
  evidence: Schema.NonEmptyArray(EvidenceV1),
});
export type CompletionSubmissionV1 = typeof CompletionSubmissionV1.Type;

export const decodeCompletionSubmissionV1 = Schema.decodeUnknownEffect(
  CompletionSubmissionV1,
  strictParse,
);
