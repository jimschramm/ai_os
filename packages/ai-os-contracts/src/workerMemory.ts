import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ContextPackageSnapshotV1,
  decodeContextPackageSnapshotV1,
  freezeInPlace,
} from "./assignment.ts";
import {
  ContractId,
  ContractText,
  ContractVersion,
  GitSha,
  IsoDateTime,
  strictParse,
} from "./common.ts";
import { ContractTransitionError } from "./errors.ts";
import {
  AcceptedFactV1,
  applyMemoryEvent,
  type MemoryFactV1,
  MemoryNodeKindV1,
  packageFacts,
} from "./memory.ts";
import { decodeMemoryLedgerV1, type FactRevisionV1, type MemoryLedgerV1 } from "./submission.ts";
import { TaskWriteV1 } from "./taskMemory.ts";

const invalid = (detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event: "submit",
    detail,
  });

const kinds = Schema.NonEmptyArray(MemoryNodeKindV1);

/**
 * Names the actors whose provenance may be accepted. An empty list is not
 * "everyone": that would accept a worker's facts with no owner decision.
 */
export const AutoAcceptActorRuleV1 = Schema.Struct({
  kinds,
  actorIds: Schema.NonEmptyArray(ContractId),
});
export type AutoAcceptActorRuleV1 = typeof AutoAcceptActorRuleV1.Type;

/** Accepts these node kinds from any actor. The owner has to set this on purpose. */
export const AutoAcceptKindRuleV1 = Schema.Struct({
  kinds,
  anyActor: Schema.Literal(true),
});
export type AutoAcceptKindRuleV1 = typeof AutoAcceptKindRuleV1.Type;

export const AutoAcceptRuleV1 = Schema.Union([AutoAcceptActorRuleV1, AutoAcceptKindRuleV1]);
export type AutoAcceptRuleV1 = typeof AutoAcceptRuleV1.Type;

export const ProjectMemoryPolicyV1 = Schema.Struct({
  schemaVersion: ContractVersion,
  projectId: ContractId,
  enabled: Schema.Boolean,
  rules: Schema.Array(AutoAcceptRuleV1),
});
export type ProjectMemoryPolicyV1 = typeof ProjectMemoryPolicyV1.Type;

export const WorkerRegistrationV1 = Schema.Struct({
  schemaVersion: ContractVersion,
  workerId: ContractId,
  projectId: ContractId,
});
export type WorkerRegistrationV1 = typeof WorkerRegistrationV1.Type;

export const WorkerContextReadV1 = Schema.Struct({
  schemaVersion: ContractVersion,
  projectId: ContractId,
  repoCommit: GitSha,
  requirements: ContractText,
  authorizationScope: ContractText,
  asOf: IsoDateTime,
});
export type WorkerContextReadV1 = typeof WorkerContextReadV1.Type;

export const WorkerContextPackageV1 = Schema.Struct({
  schemaVersion: ContractVersion,
  projectId: ContractId,
  workerId: ContractId,
  runtime: Schema.Literal("local-worker"),
  asOf: IsoDateTime,
  facts: Schema.Array(AcceptedFactV1),
  contextPackage: ContextPackageSnapshotV1,
}).check(
  Schema.makeFilter((value) => {
    freezeInPlace(value);
    return true;
  }),
);
export type WorkerContextPackageV1 = typeof WorkerContextPackageV1.Type;

export const WorkerProposeV1 = Schema.Struct({
  schemaVersion: ContractVersion,
  projectId: ContractId,
  workerId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  /**
   * Provenance actor for this proposal. Absent means the registered worker.
   * A policy can name this actor. The worker still cannot set the submission intent.
   */
  provenanceActorId: Schema.optionalKey(ContractId),
  write: TaskWriteV1,
});
export type WorkerProposeV1 = typeof WorkerProposeV1.Type;

export const WorkerAcceptV1 = Schema.Struct({
  schemaVersion: ContractVersion,
  projectId: ContractId,
  factId: ContractId,
});
export type WorkerAcceptV1 = typeof WorkerAcceptV1.Type;

const decodePolicy = Schema.decodeUnknownEffect(ProjectMemoryPolicyV1, strictParse);
const decodeRegistration = Schema.decodeUnknownEffect(WorkerRegistrationV1, strictParse);
const decodeRead = Schema.decodeUnknownEffect(WorkerContextReadV1, strictParse);
const decodePackage = Schema.decodeUnknownEffect(WorkerContextPackageV1, strictParse);
const decodePropose = Schema.decodeUnknownEffect(WorkerProposeV1, strictParse);
const decodeAccept = Schema.decodeUnknownEffect(WorkerAcceptV1, strictParse);

const actorMatches = (rule: AutoAcceptRuleV1, actorId: string): boolean => {
  if ("actorIds" in rule) return rule.actorIds.some((actor) => actor === actorId);
  return rule.anyActor;
};

/**
 * False unless the owner enabled a rule for this project that names the fact.
 * A missing policy accepts nothing.
 */
export const policyAcceptsFact = (
  policy: ProjectMemoryPolicyV1 | null,
  fact: {
    readonly projectId: string;
    readonly kind: MemoryNodeKindV1;
    readonly provenance: { readonly actorId: string };
  },
): boolean => {
  if (policy === null || !policy.enabled || policy.projectId !== fact.projectId) return false;
  return policy.rules.some(
    (rule) =>
      rule.kinds.some((kind) => kind === fact.kind) && actorMatches(rule, fact.provenance.actorId),
  );
};

/**
 * The package is `packageFacts` for this project: accepted, current, and not
 * superseded. Proposals, other projects, and Chroma candidates are not added.
 */
export const workerContextPackage = (
  ledger: MemoryLedgerV1,
  request: unknown,
  workerId: string,
): Effect.Effect<WorkerContextPackageV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeRead(request).pipe(
      Effect.mapError(() => invalid("The context read does not match the schema.")),
    );
    const facts = packageFacts(ledger.graph, decoded.projectId, decoded.asOf);
    const contextPackage: ContextPackageSnapshotV1 = yield* decodeContextPackageSnapshotV1({
      requirements: decoded.requirements,
      memoryVersions: facts.map((fact) => fact.factId),
      repoCommit: decoded.repoCommit,
      authorizationScope: decoded.authorizationScope,
      createdAt: decoded.asOf,
    }).pipe(Effect.mapError(() => invalid("The context package does not match the schema.")));
    return yield* decodePackage({
      schemaVersion: "v1",
      projectId: decoded.projectId,
      workerId,
      runtime: "local-worker",
      asOf: decoded.asOf,
      facts,
      contextPackage,
    }).pipe(Effect.mapError(() => invalid("The context package does not match the schema.")));
  });

const currentRevision = (
  ledger: MemoryLedgerV1,
  identity: string,
  projectId: string,
): FactRevisionV1 | undefined =>
  ledger.revisions.find(
    (revision) =>
      revision.current && revision.identity === identity && revision.projectId === projectId,
  );

/**
 * Accept one proposed fact in place. Provenance stays the author's.
 * A proposal that disagrees with the current accepted text is left for the steward,
 * which is what writes SUPERSEDES. This does not supersede.
 */
export const acceptProposedFact = (
  ledger: unknown,
  input: {
    readonly factId: string;
    readonly projectId: string;
    readonly acceptedBy: string;
    readonly acceptedAt: string;
  },
): Effect.Effect<MemoryLedgerV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeMemoryLedgerV1(ledger).pipe(
      Effect.mapError(() => invalid("The memory ledger does not match the schema.")),
    );
    const fact = decoded.graph.facts.find((item) => item.factId === input.factId);
    if (fact === undefined || fact.projectId !== input.projectId) {
      return yield* invalid("That fact is not a proposal in this project.");
    }
    if (fact.acceptance !== "proposed") {
      return yield* invalid("Only a proposed fact can be accepted.");
    }
    const named = decoded.identities.find(
      (item) => item.factId === fact.factId && item.projectId === fact.projectId,
    );
    if (named === undefined) {
      return yield* invalid("A proposal needs an identity before it can be accepted.");
    }
    const current = currentRevision(decoded, named.identity, fact.projectId);
    if (current !== undefined) {
      const currentFact = decoded.graph.facts.find((item) => item.factId === current.factId);
      if (currentFact !== undefined && currentFact.body === fact.body) {
        return yield* invalid("That statement is already accepted.");
      }
      return yield* invalid(
        "That proposal conflicts with accepted knowledge. The steward resolves it.",
      );
    }
    const graph = yield* applyMemoryEvent(decoded.graph, {
      type: "accept_fact",
      factId: fact.factId,
      acceptedBy: input.acceptedBy,
      acceptedAt: input.acceptedAt,
    });
    return yield* decodeMemoryLedgerV1({
      graph,
      revisions: [
        ...decoded.revisions,
        {
          factId: fact.factId,
          identity: named.identity,
          projectId: fact.projectId,
          revision: 1,
          current: true,
        },
      ],
      identities: decoded.identities,
      conflicts: decoded.conflicts,
      receipts: decoded.receipts,
    }).pipe(Effect.mapError(() => invalid("The accepted fact does not match the schema.")));
  });

export const decodeProjectMemoryPolicyV1 = decodePolicy;
export const decodeWorkerRegistrationV1 = decodeRegistration;
export const decodeWorkerContextReadV1 = decodeRead;
export const decodeWorkerContextPackageV1 = decodePackage;
export const decodeWorkerProposeV1 = decodePropose;
export const decodeWorkerAcceptV1 = decodeAccept;

export const disabledPolicy = (projectId: string): ProjectMemoryPolicyV1 => ({
  schemaVersion: "v1",
  projectId,
  enabled: false,
  rules: [],
});

/** Facts this proposal added. Used to decide which of them a policy may accept. */
export const proposedFactsFor = (
  ledger: MemoryLedgerV1,
  factIds: ReadonlyArray<string>,
): ReadonlyArray<MemoryFactV1> =>
  factIds.flatMap((factId) => {
    const fact = ledger.graph.facts.find((item) => item.factId === factId);
    return fact === undefined ? [] : [fact];
  });
