import * as Schema from "effect/Schema";

import {
  ContractId,
  ContractText,
  ContractVersion,
  ModelId,
  Revision,
  strictParse,
} from "./common.ts";

export const QaFindingV1 = Schema.Struct({
  defect: ContractText,
  evidence: ContractText,
  expectedBehavior: ContractText,
});
export type QaFindingV1 = typeof QaFindingV1.Type;

const differentModel = Schema.makeFilter(
  (verdict: { readonly qaModel: string; readonly implementerModel: string }) =>
    verdict.qaModel !== verdict.implementerModel
      ? true
      : "QA must use a different model than the implementer.",
);

const exactAcceptance = Schema.makeFilter(
  (verdict: { readonly artifactRevision: string; readonly acceptedRevision: string }) =>
    verdict.acceptedRevision === verdict.artifactRevision
      ? true
      : "Acceptance is bound to the exact artifact revision.",
);

export const QaUnavailableV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  availability: Schema.Literal("unavailable"),
});
export type QaUnavailableV1 = typeof QaUnavailableV1.Type;

export const QaReworkV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  availability: Schema.Literal("available"),
  qaModel: ModelId,
  implementerModel: ModelId,
  verdict: Schema.Literal("rework"),
  artifactRevision: Revision,
  findings: Schema.NonEmptyArray(QaFindingV1),
}).check(differentModel);
export type QaReworkV1 = typeof QaReworkV1.Type;

export const QaAcceptV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  availability: Schema.Literal("available"),
  qaModel: ModelId,
  implementerModel: ModelId,
  verdict: Schema.Literal("accept"),
  artifactRevision: Revision,
  acceptedRevision: Revision,
  findings: Schema.Array(QaFindingV1),
}).check(differentModel, exactAcceptance);
export type QaAcceptV1 = typeof QaAcceptV1.Type;

export const QaVerdictV1 = Schema.Union([QaUnavailableV1, QaReworkV1, QaAcceptV1]);
export type QaVerdictV1 = typeof QaVerdictV1.Type;

export const decodeQaVerdictV1 = Schema.decodeUnknownEffect(QaVerdictV1, strictParse);
