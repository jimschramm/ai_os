import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ContextPackageSnapshotV1,
  decodeContextPackageSnapshotV1,
  freezeInPlace,
  freezeSnapshot,
} from "./assignment.ts";
import { timeAtOrBefore, timeBefore } from "./canonical.ts";
import {
  ContractId,
  ContractText,
  ContractVersion,
  GitSha,
  IsoDateTime,
  strictParse,
} from "./common.ts";
import { ContractTransitionError } from "./errors.ts";

export const MemoryNodeKindV1 = Schema.Literals([
  "Project",
  "Repository",
  "Environment",
  "Requirement",
  "Instruction",
  "Decision",
  "Task",
  "Attempt",
  "Handoff",
  "Artifact",
  "Source",
  "Verification",
  "Agent",
  "User",
  "Procedure",
]);
export type MemoryNodeKindV1 = typeof MemoryNodeKindV1.Type;

export const MemoryRelationshipTypeV1 = Schema.Literals([
  "BELONGS_TO",
  "DEPLOYED_IN",
  "APPLIES_TO",
  "CONSTRAINS",
  "SUPERSEDES",
  "DEPENDS_ON",
  "IMPLEMENTS",
  "CONTINUES",
  "PRODUCED_BY",
  "SUPPORTED_BY",
  "VERIFIED_BY",
  "ASSIGNED_TO",
  "ACCEPTED_BY",
  "USES",
]);
export type MemoryRelationshipTypeV1 = typeof MemoryRelationshipTypeV1.Type;

export const ProvenanceV1 = Schema.Struct({
  actorId: ContractId,
  at: IsoDateTime,
});
export type ProvenanceV1 = typeof ProvenanceV1.Type;

export const ValidityWindowV1 = Schema.Struct({
  from: IsoDateTime,
  until: Schema.NullOr(IsoDateTime),
}).check(
  Schema.makeFilter((window) =>
    window.until === null || timeBefore(window.from, window.until)
      ? true
      : "The validity window must end after it starts.",
  ),
);
export type ValidityWindowV1 = typeof ValidityWindowV1.Type;

const factFields = {
  factId: ContractId,
  projectId: ContractId,
  kind: MemoryNodeKindV1,
  body: ContractText,
  provenance: ProvenanceV1,
  validity: ValidityWindowV1,
};

export const ProposedFactV1 = Schema.Struct({
  acceptance: Schema.Literal("proposed"),
  ...factFields,
});
export type ProposedFactV1 = typeof ProposedFactV1.Type;

export const AcceptedFactV1 = Schema.Struct({
  acceptance: Schema.Literal("accepted"),
  ...factFields,
  acceptedBy: ContractId,
  acceptedAt: IsoDateTime,
});
export type AcceptedFactV1 = typeof AcceptedFactV1.Type;

export const SupersededFactV1 = Schema.Struct({
  acceptance: Schema.Literal("superseded"),
  ...factFields,
  acceptedBy: ContractId,
  acceptedAt: IsoDateTime,
  supersededBy: ContractId,
});
export type SupersededFactV1 = typeof SupersededFactV1.Type;

export const MemoryFactV1 = Schema.Union([ProposedFactV1, AcceptedFactV1, SupersededFactV1]);
export type MemoryFactV1 = typeof MemoryFactV1.Type;

const relationshipFields = {
  relationshipId: ContractId,
  projectId: ContractId,
  relationshipType: MemoryRelationshipTypeV1,
  fromId: ContractId,
  toId: ContractId,
  provenance: ProvenanceV1,
  validity: ValidityWindowV1,
};

export const ProposedRelationshipV1 = Schema.Struct({
  acceptance: Schema.Literal("proposed"),
  ...relationshipFields,
});
export type ProposedRelationshipV1 = typeof ProposedRelationshipV1.Type;

export const AcceptedRelationshipV1 = Schema.Struct({
  acceptance: Schema.Literal("accepted"),
  ...relationshipFields,
  acceptedBy: ContractId,
  acceptedAt: IsoDateTime,
});
export type AcceptedRelationshipV1 = typeof AcceptedRelationshipV1.Type;

export const MemoryRelationshipV1 = Schema.Union([ProposedRelationshipV1, AcceptedRelationshipV1]);
export type MemoryRelationshipV1 = typeof MemoryRelationshipV1.Type;

export const MemoryCandidateV1 = Schema.Struct({
  nodeId: ContractId,
  score: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  source: Schema.Literal("chroma"),
});
export type MemoryCandidateV1 = typeof MemoryCandidateV1.Type;

export const MemoryGraphV1 = Schema.Struct({
  facts: Schema.Array(MemoryFactV1),
  relationships: Schema.Array(MemoryRelationshipV1),
}).check(
  Schema.makeFilter((graph) => {
    freezeInPlace(graph);
    return true;
  }),
);
export type MemoryGraphV1 = typeof MemoryGraphV1.Type;

export const RetrievalRequestV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  projectId: ContractId,
  asOf: IsoDateTime,
  question: ContractText,
  requirements: ContractText,
  repoCommit: GitSha,
  authorizationScope: ContractText,
});
export type RetrievalRequestV1 = typeof RetrievalRequestV1.Type;

export const RetrievalResponseV1 = Schema.Struct({
  version: ContractVersion,
  contextPackage: ContextPackageSnapshotV1,
  candidates: Schema.Array(MemoryCandidateV1),
}).check(
  Schema.makeFilter((response) => {
    freezeInPlace(response);
    return true;
  }),
);
export type RetrievalResponseV1 = typeof RetrievalResponseV1.Type;

export const MemoryEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("propose_fact"), fact: ProposedFactV1 }),
  Schema.Struct({
    type: Schema.Literal("accept_fact"),
    factId: ContractId,
    acceptedBy: ContractId,
    acceptedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("supersede"),
    relationship: AcceptedRelationshipV1,
  }),
]);
export type MemoryEvent = typeof MemoryEvent.Type;

const covers = (window: { readonly from: string; readonly until: string | null }, asOf: string) =>
  timeAtOrBefore(window.from, asOf) && (window.until === null || timeBefore(asOf, window.until));

export type EligibleFactV1 = AcceptedFactV1;

const supersededFactIds = (graph: MemoryGraphV1, projectId: string, asOf: string): Set<string> => {
  const superseded = new Set<string>();
  for (const relationship of graph.relationships) {
    if (
      relationship.acceptance !== "accepted" ||
      relationship.relationshipType !== "SUPERSEDES" ||
      relationship.projectId !== projectId ||
      !covers(relationship.validity, asOf)
    ) {
      continue;
    }
    superseded.add(relationship.toId);
  }
  return superseded;
};

export const packageFacts = (
  graph: MemoryGraphV1,
  projectId: string,
  asOf: string,
): ReadonlyArray<EligibleFactV1> => {
  const superseded = supersededFactIds(graph, projectId, asOf);
  return graph.facts.filter(
    (fact): fact is EligibleFactV1 =>
      fact.acceptance === "accepted" &&
      fact.projectId === projectId &&
      covers(fact.validity, asOf) &&
      !superseded.has(fact.factId),
  );
};

/**
 * Pending proposals for a project. These are not accepted knowledge.
 * Callers label them `proposed, not accepted` and keep them out of `packageFacts`.
 */
export const packageProposals = (
  graph: MemoryGraphV1,
  projectId: string,
  asOf: string,
): ReadonlyArray<ProposedFactV1> =>
  graph.facts.filter(
    (fact): fact is ProposedFactV1 =>
      fact.acceptance === "proposed" && fact.projectId === projectId && covers(fact.validity, asOf),
  );

export const historyFacts = (
  graph: MemoryGraphV1,
  projectId: string,
): ReadonlyArray<MemoryFactV1> =>
  graph.facts.filter(
    (fact) =>
      fact.projectId === projectId &&
      (fact.acceptance === "accepted" || fact.acceptance === "superseded"),
  );

const memoryError = (event: string, detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "memory_not_eligible",
    from: "idle",
    event,
    detail,
  });

const eventTypeOf = (value: unknown): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  ) {
    return value.type;
  }
  return "memory";
};

const invalidMemory = (event: string, detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event,
    detail,
  });

const invalidGraph = (event: string, detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_graph",
    from: "idle",
    event,
    detail,
  });

/**
 * Status is an invariant of the accepted SUPERSEDES edges, not a second source
 * of eligibility. Ids are unique. An accepted edge starts at a fact that was accepted (status accepted or
 * superseded) and ends at the superseded fact. A later link in the chain does
 * not invalidate the earlier edge. A self-edge, a cross-project edge, or a
 * cycle is not a graph we can package.
 */
const supersessionInvariant = (graph: MemoryGraphV1): string | null => {
  const seenFacts = new Set<string>();
  for (const fact of graph.facts) {
    if (seenFacts.has(fact.factId)) {
      return "Fact ids must be unique.";
    }
    seenFacts.add(fact.factId);
  }
  const seenRelationships = new Set<string>();
  for (const relationship of graph.relationships) {
    if (seenRelationships.has(relationship.relationshipId)) {
      return "Relationship ids must be unique.";
    }
    seenRelationships.add(relationship.relationshipId);
  }
  const facts = new Map(graph.facts.map((fact) => [fact.factId, fact]));
  const acceptedEdges: Array<AcceptedRelationshipV1> = [];
  for (const relationship of graph.relationships) {
    if (relationship.relationshipType !== "SUPERSEDES") {
      continue;
    }
    if (relationship.fromId === relationship.toId) {
      return "A fact cannot supersede itself.";
    }
    const newer = facts.get(relationship.fromId);
    const older = facts.get(relationship.toId);
    if (newer === undefined || older === undefined) {
      return "A SUPERSEDES edge names a fact that is not in the graph.";
    }
    if (newer.projectId !== older.projectId || relationship.projectId !== newer.projectId) {
      return "A SUPERSEDES edge stays inside one project.";
    }
    if (relationship.acceptance !== "accepted") {
      continue;
    }
    acceptedEdges.push(relationship);
  }
  const next = new Map<string, Array<string>>();
  for (const edge of acceptedEdges) {
    const targets = next.get(edge.fromId) ?? [];
    targets.push(edge.toId);
    next.set(edge.fromId, targets);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (factId: string): boolean => {
    const seen = color.get(factId) ?? 0;
    if (seen === 1) {
      return true;
    }
    if (seen === 2) {
      return false;
    }
    color.set(factId, 1);
    for (const target of next.get(factId) ?? []) {
      if (visit(target)) {
        return true;
      }
    }
    color.set(factId, 2);
    return false;
  };
  for (const factId of next.keys()) {
    if (visit(factId)) {
      return "SUPERSEDES edges form a cycle.";
    }
  }
  for (const edge of acceptedEdges) {
    const newer = facts.get(edge.fromId);
    const older = facts.get(edge.toId);
    if (newer === undefined || older === undefined) {
      return "A SUPERSEDES edge names a fact that is not in the graph.";
    }
    if (newer.acceptance !== "accepted" && newer.acceptance !== "superseded") {
      return "An accepted SUPERSEDES edge must start from an accepted fact.";
    }
    if (older.acceptance === "proposed") {
      return "An accepted SUPERSEDES edge cannot target a proposed fact.";
    }
    if (older.acceptance !== "superseded" || older.supersededBy !== edge.fromId) {
      return "An accepted SUPERSEDES edge requires the older fact to be superseded by the newer fact.";
    }
  }
  for (const fact of graph.facts) {
    if (fact.acceptance !== "superseded") {
      continue;
    }
    const matched = acceptedEdges.some(
      (edge) =>
        edge.toId === fact.factId &&
        edge.fromId === fact.supersededBy &&
        edge.projectId === fact.projectId,
    );
    if (!matched) {
      return "A superseded fact requires an accepted SUPERSEDES edge.";
    }
  }
  return null;
};

const applyMemory = (
  graph: MemoryGraphV1,
  event: MemoryEvent,
): Effect.Effect<MemoryGraphV1, ContractTransitionError> => {
  if (event.type === "propose_fact") {
    if (graph.facts.some((fact) => fact.factId === event.fact.factId)) {
      return Effect.fail(memoryError(event.type, "That fact is already in the graph."));
    }
    return Effect.succeed(freezeSnapshot({ ...graph, facts: [...graph.facts, event.fact] }));
  }
  if (event.type === "accept_fact") {
    const fact = graph.facts.find((item) => item.factId === event.factId);
    if (fact === undefined || fact.acceptance !== "proposed") {
      return Effect.fail(
        memoryError(event.type, "Only an explicit acceptance of a proposed fact is knowledge."),
      );
    }
    const accepted: AcceptedFactV1 = {
      acceptance: "accepted",
      factId: fact.factId,
      projectId: fact.projectId,
      kind: fact.kind,
      body: fact.body,
      provenance: fact.provenance,
      validity: fact.validity,
      acceptedBy: event.acceptedBy,
      acceptedAt: event.acceptedAt,
    };
    return Effect.succeed(
      freezeSnapshot({
        ...graph,
        facts: graph.facts.map((item) => (item.factId === fact.factId ? accepted : item)),
      }),
    );
  }
  // fromId is the newer fact and toId is the older one. Both stay in the graph.
  if (event.relationship.relationshipType !== "SUPERSEDES") {
    return Effect.fail(memoryError(event.type, "Supersession uses the SUPERSEDES relationship."));
  }
  const newer = graph.facts.find((fact) => fact.factId === event.relationship.fromId);
  const older = graph.facts.find((fact) => fact.factId === event.relationship.toId);
  if (newer === undefined || newer.acceptance !== "accepted") {
    return Effect.fail(memoryError(event.type, "The newer fact must already be accepted."));
  }
  // A proposal was never accepted. Closing it still uses the superseded shape:
  // the resolver is the actor who accepted the newer fact.
  if (older === undefined || (older.acceptance !== "accepted" && older.acceptance !== "proposed")) {
    return Effect.fail(
      memoryError(event.type, "The older fact must already be accepted or still proposed."),
    );
  }
  if (newer.factId === older.factId) {
    return Effect.fail(memoryError(event.type, "A fact cannot supersede itself."));
  }
  if (newer.projectId !== older.projectId || event.relationship.projectId !== newer.projectId) {
    return Effect.fail(memoryError(event.type, "A relationship stays inside one project."));
  }
  const superseded: SupersededFactV1 = {
    acceptance: "superseded",
    factId: older.factId,
    projectId: older.projectId,
    kind: older.kind,
    body: older.body,
    provenance: older.provenance,
    validity: older.validity,
    acceptedBy: older.acceptance === "accepted" ? older.acceptedBy : newer.acceptedBy,
    acceptedAt: older.acceptance === "accepted" ? older.acceptedAt : newer.acceptedAt,
    supersededBy: newer.factId,
  };
  return Effect.succeed(
    freezeSnapshot({
      facts: graph.facts.map((fact) => (fact.factId === older.factId ? superseded : fact)),
      relationships: [...graph.relationships, event.relationship],
    }),
  );
};

const decodeCandidates = Schema.decodeUnknownEffect(Schema.Array(MemoryCandidateV1), strictParse);

const decodeMemoryGraphStruct = Schema.decodeUnknownEffect(MemoryGraphV1, strictParse);

const decodeGraph = (
  graph: unknown,
  event: string,
): Effect.Effect<MemoryGraphV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeMemoryGraphStruct(graph).pipe(
      Effect.mapError(() => invalidMemory(event, "The memory graph does not match the schema.")),
    );
    const problem = supersessionInvariant(decoded);
    if (problem !== null) {
      return yield* invalidGraph(event, problem);
    }
    return decoded;
  });

export const decodeMemoryGraphV1 = (
  graph: unknown,
): Effect.Effect<MemoryGraphV1, ContractTransitionError> => decodeGraph(graph, "memory");
export const decodeMemoryEvent = Schema.decodeUnknownEffect(MemoryEvent, strictParse);
export const decodeRetrievalRequestV1 = Schema.decodeUnknownEffect(RetrievalRequestV1, strictParse);
export const decodeRetrievalResponseV1 = Schema.decodeUnknownEffect(
  RetrievalResponseV1,
  strictParse,
);

export const initialMemoryGraph: MemoryGraphV1 = { facts: [], relationships: [] };

export const applyMemoryEvent = (
  graph: unknown,
  event: unknown,
): Effect.Effect<MemoryGraphV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decodedGraph = yield* decodeGraph(graph, eventTypeOf(event));
    const decodedEvent = yield* decodeMemoryEvent(event).pipe(
      Effect.mapError(() =>
        invalidMemory(eventTypeOf(event), "The memory event does not match the schema."),
      ),
    );
    const next = yield* applyMemory(decodedGraph, decodedEvent);
    return yield* decodeGraph(next, decodedEvent.type);
  });

export const buildRetrieval = (
  graph: unknown,
  request: unknown,
  candidates: unknown,
): Effect.Effect<RetrievalResponseV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decodedGraph = yield* decodeGraph(graph, "retrieve");
    const decodedRequest = yield* decodeRetrievalRequestV1(request).pipe(
      Effect.mapError(() =>
        invalidMemory("retrieve", "The retrieval request does not match the schema."),
      ),
    );
    const decodedCandidates = yield* decodeCandidates(candidates).pipe(
      Effect.mapError(() => invalidMemory("retrieve", "The candidates do not match the schema.")),
    );
    const eligible = packageFacts(decodedGraph, decodedRequest.projectId, decodedRequest.asOf);
    const contextPackage = yield* decodeContextPackageSnapshotV1({
      requirements: decodedRequest.requirements,
      memoryVersions: eligible.map((fact) => fact.factId),
      repoCommit: decodedRequest.repoCommit,
      authorizationScope: decodedRequest.authorizationScope,
      createdAt: decodedRequest.asOf,
    }).pipe(
      Effect.mapError(() =>
        invalidMemory("retrieve", "The context package does not match the schema."),
      ),
    );
    const response = {
      version: "v1" as const,
      contextPackage,
      candidates: decodedCandidates,
    };
    return yield* decodeRetrievalResponseV1(response).pipe(
      Effect.mapError(() =>
        invalidMemory("retrieve", "The retrieval response does not match the schema."),
      ),
    );
  });
