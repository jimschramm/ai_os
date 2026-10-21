import * as Schema from "effect/Schema";

import {
  ArtifactRevisionV1,
  ContractId,
  ContractText,
  ContractVersion,
  ModelRef,
  sameModelName,
  sameRevision,
  strictParse,
} from "./common.ts";

export const QaFindingV1 = Schema.Struct({
  defect: ContractText,
  evidence: ContractText,
  expectedBehavior: ContractText,
});
export type QaFindingV1 = typeof QaFindingV1.Type;

const differentModel = Schema.makeFilter(
  (verdict: {
    readonly qaModel: ModelRef | string;
    readonly implementerModel: ModelRef | string;
  }) =>
    sameModelName(verdict.qaModel, verdict.implementerModel)
      ? "QA must use a different model than the implementer."
      : true,
);

const exactAcceptance = Schema.makeFilter(
  (verdict: {
    readonly artifactRevision: ArtifactRevisionV1;
    readonly acceptedRevision: ArtifactRevisionV1;
  }) =>
    sameRevision(verdict.acceptedRevision, verdict.artifactRevision)
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
  qaModel: ModelRef,
  implementerModel: ModelRef,
  verdict: Schema.Literal("rework"),
  artifactRevision: ArtifactRevisionV1,
  findings: Schema.NonEmptyArray(QaFindingV1),
}).check(differentModel);
export type QaReworkV1 = typeof QaReworkV1.Type;

export const QaAcceptV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  availability: Schema.Literal("available"),
  qaModel: ModelRef,
  implementerModel: ModelRef,
  verdict: Schema.Literal("accept"),
  artifactRevision: ArtifactRevisionV1,
  acceptedRevision: ArtifactRevisionV1,
  findings: Schema.Array(QaFindingV1),
}).check(differentModel, exactAcceptance);
export type QaAcceptV1 = typeof QaAcceptV1.Type;

export const QaVerdictV1 = Schema.Union([QaUnavailableV1, QaReworkV1, QaAcceptV1]);
export type QaVerdictV1 = typeof QaVerdictV1.Type;

export const decodeQaVerdictV1 = Schema.decodeUnknownEffect(QaVerdictV1, strictParse);
