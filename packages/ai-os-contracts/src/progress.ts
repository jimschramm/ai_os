import * as Schema from "effect/Schema";

import { freezeInPlace } from "./assignment.ts";
import { timeBefore } from "./canonical.ts";
import {
  ArtifactRevisionV1,
  ContractId,
  ContractText,
  ContractVersion,
  IsoDateTime,
  PositiveInt,
  strictParse,
} from "./common.ts";

export const BlockerV1 = Schema.Struct({
  summary: ContractText,
  ownerId: ContractId,
  nextAction: ContractText,
});
export type BlockerV1 = typeof BlockerV1.Type;

export const PartialArtifactV1 = Schema.Struct({
  artifactId: ContractId,
  revision: ArtifactRevisionV1,
  note: ContractText,
});
export type PartialArtifactV1 = typeof PartialArtifactV1.Type;

export const ProgressReportV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  generation: PositiveInt,
  leaseId: ContractId,
  status: Schema.Literals(["working", "blocked"]),
  blockers: Schema.Array(BlockerV1),
  partialArtifacts: Schema.Array(PartialArtifactV1),
}).check(
  Schema.makeFilter((report) => {
    if (report.status === "blocked" && report.blockers.length === 0) {
      return "A blocked status requires a blocker with a concrete next action.";
    }
    if (report.status === "working" && report.blockers.length > 0) {
      return "Working progress cannot carry blockers.";
    }
    freezeInPlace(report);
    return true;
  }),
);
export type ProgressReportV1 = typeof ProgressReportV1.Type;

export const HeartbeatV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  generation: PositiveInt,
  leaseId: ContractId,
  observedAt: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
}).check(
  Schema.makeFilter((heartbeat) =>
    timeBefore(heartbeat.observedAt, heartbeat.leaseExpiresAt)
      ? true
      : "The lease must expire after the heartbeat.",
  ),
);
export type HeartbeatV1 = typeof HeartbeatV1.Type;

export const HeartbeatLapseV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  generation: PositiveInt,
  leaseId: ContractId,
});
export type HeartbeatLapseV1 = typeof HeartbeatLapseV1.Type;

export const LeaseExpiredV1 = Schema.Struct({
  taskId: ContractId,
  attemptId: ContractId,
  generation: PositiveInt,
  leaseId: ContractId,
});
export type LeaseExpiredV1 = typeof LeaseExpiredV1.Type;

export const decodeProgressReportV1 = Schema.decodeUnknownEffect(ProgressReportV1, strictParse);
export const decodeHeartbeatV1 = Schema.decodeUnknownEffect(HeartbeatV1, strictParse);
export const decodeHeartbeatLapseV1 = Schema.decodeUnknownEffect(HeartbeatLapseV1, strictParse);
