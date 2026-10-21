import * as Schema from "effect/Schema";

import {
  ContractId,
  ContractText,
  ContractVersion,
  GitSha,
  IsoDateTime,
  ModelRef,
  strictParse,
} from "./common.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepCopy = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => deepCopy(item)) as T;
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = deepCopy(value[key]);
    }
    return copy as T;
  }
  return value;
};

const deepFreeze = <T>(value: T): T => {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  return value;
};

export const freezeSnapshot = <T>(value: T): T => deepFreeze(deepCopy(value));

// Struct decode already copies. Freezing in the check keeps that copy immutable.
// A decodeTo transform is rebuilt by the target struct, so the freeze would not survive it.
const freezeDecoded = Schema.makeFilter(<A>(value: A) => {
  deepFreeze(value);
  return true;
});

export const ContextPackageSnapshotV1 = Schema.Struct({
  requirements: ContractText,
  memoryVersions: Schema.Array(ContractId),
  repoCommit: GitSha,
  authorizationScope: ContractText,
  createdAt: IsoDateTime,
}).check(freezeDecoded);
export type ContextPackageSnapshotV1 = typeof ContextPackageSnapshotV1.Type;

export const AssignmentV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  assignmentId: ContractId,
  workerId: ContractId,
  implementerModel: ModelRef,
  scope: ContractText,
  contextPackage: ContextPackageSnapshotV1,
}).check(freezeDecoded);
export type AssignmentV1 = typeof AssignmentV1.Type;

export const decodeAssignmentV1 = Schema.decodeUnknownEffect(AssignmentV1, strictParse);
export const decodeContextPackageSnapshotV1 = Schema.decodeUnknownEffect(
  ContextPackageSnapshotV1,
  strictParse,
);
