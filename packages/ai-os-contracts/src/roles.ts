import * as Schema from "effect/Schema";

import { baseModelName, ContractId, ModelRef, sameBaseModel, strictParse } from "./common.ts";

const InstanceId = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/),
);

/** One configured worker for a project role. The model is the requested base. */
export const RoleWorkerV1 = Schema.Struct({
  workerId: ContractId,
  instanceId: InstanceId,
  model: ModelRef,
});
export type RoleWorkerV1 = typeof RoleWorkerV1.Type;

export const ProjectRoleDefaultsV1 = Schema.Struct({
  implementer: Schema.optionalKey(RoleWorkerV1),
  qa: Schema.optionalKey(RoleWorkerV1),
});
export type ProjectRoleDefaultsV1 = typeof ProjectRoleDefaultsV1.Type;

export const RoleDefaultsFileV1 = Schema.Struct({
  projects: Schema.Record(Schema.String, ProjectRoleDefaultsV1),
});
export type RoleDefaultsFileV1 = typeof RoleDefaultsFileV1.Type;

export const decodeRoleDefaultsFile = Schema.decodeUnknownEffect(RoleDefaultsFileV1, strictParse);

/** Codex model that reviews a Sol implementation. */
export const ASTRA_QA_MODEL = "gpt-6-astra";
export const ASTRA_QA_INSTANCE = "codex";

const modelBase = (model: ModelRef | string): string | null => baseModelName(model);

/** Sol is the implementer family (`gpt-5.6-sol`, `gpt-6-sol`). Effort suffixes share that base. */
export const isSolModel = (model: ModelRef | string): boolean => {
  const base = modelBase(model);
  return base === "sol" || (base?.endsWith("-sol") ?? false);
};

export const isAstraQa = (worker: {
  readonly instanceId: string;
  readonly model: ModelRef | string;
}): boolean =>
  worker.instanceId === ASTRA_QA_INSTANCE && modelBase(worker.model) === ASTRA_QA_MODEL;

/**
 * The implementer is the project's configured worker.
 * Antigravity is advisory and is not an implementer.
 */
export const eligibleImplementer = (
  roles: ProjectRoleDefaultsV1 | undefined,
): RoleWorkerV1 | null => {
  const worker = roles?.implementer;
  if (worker === undefined) return null;
  if (worker.instanceId === "antigravity") return null;
  if (modelBase(worker.model) === null) return null;
  return worker;
};

/**
 * QA comes from the project config.
 * A Sol run only starts when that worker is Astra on Codex.
 * Any other implementer uses the configured QA worker, then the same independence check.
 * An Antigravity worker is advisory and is not QA.
 */
export const qaWorkerFor = (
  roles: ProjectRoleDefaultsV1 | undefined,
  implementerActual: ModelRef | string,
): RoleWorkerV1 | null => {
  const worker = roles?.qa;
  if (worker === undefined) return null;
  if (worker.instanceId === "antigravity") return null;
  if (modelBase(worker.model) === null) return null;
  if (isSolModel(implementerActual) && !isAstraQa(worker)) return null;
  if (sameBaseModel(worker.model, implementerActual)) return null;
  return worker;
};
