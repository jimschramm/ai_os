import * as Schema from "effect/Schema";

import {
  ContractId,
  ContractText,
  ContractVersion,
  IsoDateTime,
  ModelId,
  Revision,
  strictParse,
} from "./common.ts";

export const ContextPackageSnapshotV1 = Schema.Struct({
  requirements: ContractText,
  memoryVersions: Schema.Array(ContractId),
  repoCommit: Revision,
  authorizationScope: ContractText,
  createdAt: IsoDateTime,
});
export type ContextPackageSnapshotV1 = typeof ContextPackageSnapshotV1.Type;

export const AssignmentV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  assignmentId: ContractId,
  workerId: ContractId,
  implementerModel: ModelId,
  scope: ContractText,
  contextPackage: ContextPackageSnapshotV1,
});
export type AssignmentV1 = typeof AssignmentV1.Type;

export const decodeAssignmentV1 = Schema.decodeUnknownEffect(AssignmentV1, strictParse);
export const decodeContextPackageSnapshotV1 = Schema.decodeUnknownEffect(
  ContextPackageSnapshotV1,
  strictParse,
);
