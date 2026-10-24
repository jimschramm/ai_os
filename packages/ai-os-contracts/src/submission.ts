import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { freezeSnapshot } from "./assignment.ts";
import { ContractId, ContractText, ContractVersion, EvidenceRef, strictParse } from "./common.ts";
import { ContractTransitionError } from "./errors.ts";
import {
  AcceptedRelationshipV1,
  applyMemoryEvent,
  decodeMemoryGraphV1,
  initialMemoryGraph,
  MemoryFactV1,
  MemoryGraphV1,
  ProposedFactV1,
  ProposedRelationshipV1,
  ProvenanceV1,
} from "./memory.ts";

export const SubmissionOutcomeV1 = Schema.Literals([
  "accepted",
  "duplicate",
  "conflict",
  "rejected",
  "pending",
]);
export type SubmissionOutcomeV1 = typeof SubmissionOutcomeV1.Type;

export const SubmissionIntentV1 = Schema.Literals(["propose", "accept"]);
export type SubmissionIntentV1 = typeof SubmissionIntentV1.Type;

export const ExpectedFactVersionV1 = Schema.Struct({
  factId: ContractId,
  revision: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(1_000_000),
  ),
});
export type ExpectedFactVersionV1 = typeof ExpectedFactVersionV1.Type;

export const SourceEvidenceV1 = Schema.Struct({
  evidenceId: EvidenceRef,
  note: ContractText,
});
export type SourceEvidenceV1 = typeof SourceEvidenceV1.Type;

export const SubmissionFactV1 = Schema.Struct({
  identity: ContractId,
  fact: ProposedFactV1,
});
export type SubmissionFactV1 = typeof SubmissionFactV1.Type;

const evidenceList = Schema.Array(SourceEvidenceV1).check(
  Schema.makeFilter((items: ReadonlyArray<SourceEvidenceV1>) =>
    items.length > 0 ? true : "A submission needs source evidence.",
  ),
);

export const SubmissionV1 = Schema.Struct({
  version: ContractVersion,
  submissionId: ContractId,
  idempotencyKey: ContractId,
  projectId: ContractId,
  authorId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  evidence: evidenceList,
  expectedVersions: Schema.Array(ExpectedFactVersionV1),
  intent: SubmissionIntentV1,
  facts: Schema.Array(SubmissionFactV1),
  relationships: Schema.Array(ProposedRelationshipV1),
});
export type SubmissionV1 = typeof SubmissionV1.Type;

export const SubmissionReceiptV1 = Schema.Struct({
  version: ContractVersion,
  submissionId: ContractId,
  idempotencyKey: ContractId,
  projectId: ContractId,
  authorId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  evidence: evidenceList,
  expectedVersions: Schema.Array(ExpectedFactVersionV1),
  outcome: SubmissionOutcomeV1,
  detail: ContractText,
  factIds: Schema.Array(ContractId),
  relationshipIds: Schema.Array(ContractId),
  conflictIds: Schema.Array(ContractId),
  originalSubmissionId: Schema.NullOr(ContractId),
});
export type SubmissionReceiptV1 = typeof SubmissionReceiptV1.Type;

export const FactRevisionV1 = Schema.Struct({
  factId: ContractId,
  identity: ContractId,
  projectId: ContractId,
  revision: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(1_000_000),
  ),
  current: Schema.Boolean,
});
export type FactRevisionV1 = typeof FactRevisionV1.Type;

export const FactIdentityV1 = Schema.Struct({
  factId: ContractId,
  identity: ContractId,
  projectId: ContractId,
});
export type FactIdentityV1 = typeof FactIdentityV1.Type;

export const MemoryConflictV1 = Schema.Struct({
  conflictId: ContractId,
  projectId: ContractId,
  submissionId: ContractId,
  authorId: ContractId,
  acceptedAuthorId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  identity: ContractId,
  acceptedFactId: ContractId,
  proposedFactId: ContractId,
  resolvedBySubmissionId: Schema.NullOr(ContractId),
});
export type MemoryConflictV1 = typeof MemoryConflictV1.Type;

export const MemoryLedgerV1 = Schema.Struct({
  graph: MemoryGraphV1,
  revisions: Schema.Array(FactRevisionV1),
  identities: Schema.Array(FactIdentityV1),
  conflicts: Schema.Array(MemoryConflictV1),
  receipts: Schema.Array(SubmissionReceiptV1),
});
export type MemoryLedgerV1 = typeof MemoryLedgerV1.Type;

export const SubmissionResultV1 = Schema.Struct({
  ledger: MemoryLedgerV1,
  receipt: SubmissionReceiptV1,
});
export type SubmissionResultV1 = typeof SubmissionResultV1.Type;

const decodeLedger = Schema.decodeUnknownEffect(MemoryLedgerV1, strictParse);
const decodeSubmission = Schema.decodeUnknownEffect(SubmissionV1, strictParse);
const decodeReceipt = Schema.decodeUnknownEffect(SubmissionReceiptV1, strictParse);
const decodeResult = Schema.decodeUnknownEffect(SubmissionResultV1, strictParse);

const invalid = (detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event: "submit",
    detail,
  });

export const initialMemoryLedger: MemoryLedgerV1 = {
  graph: initialMemoryGraph,
  revisions: [],
  identities: [],
  conflicts: [],
  receipts: [],
};

const contractId = (value: string): string | null =>
  value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;

const currentRevision = (
  ledger: MemoryLedgerV1,
  identity: string,
  projectId: string,
): FactRevisionV1 | undefined =>
  ledger.revisions.find(
    (revision) =>
      revision.current && revision.identity === identity && revision.projectId === projectId,
  );

const factById = (graph: MemoryGraphV1, factId: string): MemoryFactV1 | undefined =>
  graph.facts.find((fact) => fact.factId === factId);

const authorOf = (fact: MemoryFactV1 | undefined): string => fact?.provenance.actorId ?? "unknown";

interface PublishPlan {
  readonly mode: "pending" | "accepted" | "conflict";
  readonly facts: ReadonlyArray<SubmissionFactV1>;
  readonly replacements: ReadonlyArray<{
    readonly next: SubmissionFactV1;
    readonly previous: FactRevisionV1;
  }>;
  readonly conflicts: ReadonlyArray<{
    readonly accepted: FactRevisionV1;
    readonly proposed: SubmissionFactV1;
  }>;
  readonly relationships: ReadonlyArray<ProposedRelationshipV1>;
  readonly detail: string;
}

const reject = (
  ledger: MemoryLedgerV1,
  submission: SubmissionV1,
  detail: string,
): Effect.Effect<SubmissionResultV1, ContractTransitionError> =>
  finish(ledger, {
    version: "v1",
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    projectId: submission.projectId,
    authorId: submission.authorId,
    taskId: submission.taskId,
    attemptId: submission.attemptId,
    evidence: submission.evidence,
    expectedVersions: submission.expectedVersions,
    outcome: "rejected",
    detail,
    factIds: [],
    relationshipIds: [],
    conflictIds: [],
    originalSubmissionId: null,
  });

const finish = (
  ledger: MemoryLedgerV1,
  receipt: SubmissionReceiptV1,
): Effect.Effect<SubmissionResultV1, ContractTransitionError> =>
  decodeResult({ ledger, receipt }).pipe(
    Effect.mapError(() => invalid("The submission result does not match the schema.")),
  );

const duplicateReceipt = (
  stored: SubmissionReceiptV1,
): Effect.Effect<SubmissionReceiptV1, ContractTransitionError> =>
  decodeReceipt({
    ...stored,
    outcome: "duplicate",
    detail: "This idempotency key was already submitted.",
    originalSubmissionId: stored.submissionId,
  }).pipe(Effect.mapError(() => invalid("The stored submission does not match the schema.")));

const structuralProblems = (
  ledger: MemoryLedgerV1,
  submission: SubmissionV1,
  acceptingAuthorId: string,
): string | null => {
  if (submission.facts.length === 0 && submission.relationships.length === 0) {
    return "A submission needs a fact or a relationship.";
  }
  if (ledger.receipts.some((receipt) => receipt.submissionId === submission.submissionId)) {
    return "That submission id was already used.";
  }
  if (submission.intent === "accept" && submission.authorId !== acceptingAuthorId) {
    return "Only the accepting authority can accept knowledge.";
  }
  if (!contractId(acceptingAuthorId)) {
    return "The accepting authority is not an id.";
  }
  const factIds = new Set(ledger.graph.facts.map((fact) => fact.factId));
  const relationshipIds = new Set(ledger.graph.relationships.map((item) => item.relationshipId));
  const seenFacts = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const item of submission.facts) {
    if (item.fact.projectId !== submission.projectId) {
      return "A fact stays inside the submission's project.";
    }
    if (item.fact.provenance.actorId !== submission.authorId) {
      return "The fact author is the agent that submitted it.";
    }
    if (seenFacts.has(item.fact.factId) || factIds.has(item.fact.factId)) {
      return "Fact ids must be unique.";
    }
    seenFacts.add(item.fact.factId);
    if (seenIdentities.has(item.identity)) {
      return "A submission states each identity once.";
    }
    seenIdentities.add(item.identity);
    const current = currentRevision(ledger, item.identity, submission.projectId);
    const currentFact = current === undefined ? undefined : factById(ledger.graph, current.factId);
    if (currentFact !== undefined && currentFact.kind !== item.fact.kind) {
      return "An identity keeps its node kind.";
    }
  }
  const available = new Set([...factIds, ...seenFacts]);
  const seenRelationships = new Set<string>();
  for (const relationship of submission.relationships) {
    if (relationship.projectId !== submission.projectId) {
      return "A relationship stays inside the submission's project.";
    }
    if (relationship.provenance.actorId !== submission.authorId) {
      return "The relationship author is the agent that submitted it.";
    }
    if (relationship.relationshipType === "SUPERSEDES") {
      return "Supersession is recorded by an acceptance, not by the submission.";
    }
    if (
      seenRelationships.has(relationship.relationshipId) ||
      relationshipIds.has(relationship.relationshipId)
    ) {
      return "Relationship ids must be unique.";
    }
    seenRelationships.add(relationship.relationshipId);
    if (!available.has(relationship.fromId) || !available.has(relationship.toId)) {
      return "A relationship names a fact that is not in the graph.";
    }
  }
  const seenVersions = new Set<string>();
  for (const expected of submission.expectedVersions) {
    if (seenVersions.has(expected.factId)) {
      return "Expected versions name each fact once.";
    }
    seenVersions.add(expected.factId);
    const revision = ledger.revisions.find((item) => item.factId === expected.factId);
    if (revision === undefined || revision.projectId !== submission.projectId) {
      return "An expected version names an accepted fact in this project.";
    }
  }
  return null;
};

const planSubmission = (ledger: MemoryLedgerV1, submission: SubmissionV1): PublishPlan | string => {
  const stale = submission.expectedVersions.filter((expected) => {
    const revision = ledger.revisions.find((item) => item.factId === expected.factId);
    return revision === undefined || !revision.current || revision.revision !== expected.revision;
  });
  const replacements: Array<{ next: SubmissionFactV1; previous: FactRevisionV1 }> = [];
  const conflicts: Array<{ accepted: FactRevisionV1; proposed: SubmissionFactV1 }> = [];
  const facts: SubmissionFactV1[] = [];
  for (const item of submission.facts) {
    const current = currentRevision(ledger, item.identity, submission.projectId);
    const currentFact = current === undefined ? undefined : factById(ledger.graph, current.factId);
    if (current === undefined || currentFact === undefined) {
      facts.push(item);
      continue;
    }
    // The same text is already accepted only when the author named the current
    // revision. A stale revision is an open conflict, and the proposal is kept.
    if (currentFact.body === item.fact.body) {
      const namedStaleRevision = stale.some((expected) => {
        const named = ledger.revisions.find((revision) => revision.factId === expected.factId);
        return named?.identity === item.identity && named.projectId === submission.projectId;
      });
      if (!namedStaleRevision) {
        continue;
      }
      conflicts.push({ accepted: current, proposed: item });
      facts.push(item);
      continue;
    }
    const expected = submission.expectedVersions.find(
      (version) => version.factId === current.factId,
    );
    const versionMatches = expected !== undefined && expected.revision === current.revision;
    if (submission.intent === "accept" && versionMatches && stale.length === 0) {
      replacements.push({ next: item, previous: current });
      facts.push(item);
      continue;
    }
    if (submission.intent === "accept" && expected === undefined && stale.length === 0) {
      return "Name the accepted version this statement replaces.";
    }
    conflicts.push({ accepted: current, proposed: item });
    facts.push(item);
  }
  if (facts.length === 0 && submission.relationships.length === 0) {
    return "That statement is already accepted.";
  }
  if (stale.length > 0 && facts.length === 0) {
    return "A stale submission needs the statement that conflicts.";
  }
  const mode =
    conflicts.length > 0 || stale.length > 0
      ? "conflict"
      : submission.intent === "accept"
        ? "accepted"
        : "pending";
  if (mode === "conflict" && stale.length > 0) {
    for (const expected of stale) {
      const historical = ledger.revisions.find((item) => item.factId === expected.factId);
      const current =
        historical === undefined
          ? undefined
          : currentRevision(ledger, historical.identity, historical.projectId);
      const proposed = facts[0];
      if (
        current !== undefined &&
        proposed !== undefined &&
        !conflicts.some(
          (item) =>
            item.accepted.factId === current.factId &&
            item.proposed.fact.factId === proposed.fact.factId,
        )
      ) {
        conflicts.push({ accepted: current, proposed });
      }
    }
  }
  if (mode === "conflict" && conflicts.length === 0) {
    return "The conflicting statement could not be paired with an accepted fact.";
  }
  return {
    mode,
    facts,
    replacements: mode === "accepted" ? replacements : [],
    conflicts: mode === "conflict" ? conflicts : [],
    relationships: submission.relationships,
    detail:
      mode === "conflict"
        ? "The accepted statement was kept. The submission is an open conflict."
        : mode === "accepted"
          ? "Accepted a new version."
          : "Recorded as a proposal. Accepted knowledge was not changed.",
  };
};

const provenanceAt = (provenance: ProvenanceV1): string => provenance.at;

const acceptRelationship = (
  relationship: ProposedRelationshipV1,
  acceptedBy: string,
): AcceptedRelationshipV1 => ({
  acceptance: "accepted",
  relationshipId: relationship.relationshipId,
  projectId: relationship.projectId,
  relationshipType: relationship.relationshipType,
  fromId: relationship.fromId,
  toId: relationship.toId,
  provenance: relationship.provenance,
  validity: relationship.validity,
  acceptedBy,
  acceptedAt: provenanceAt(relationship.provenance),
});

const supersedesEdge = (
  submission: SubmissionV1,
  next: SubmissionFactV1,
  previousFactId: string,
  index: number,
): AcceptedRelationshipV1 | string => {
  const relationshipId = contractId(`sup-${submission.submissionId}-${index}`);
  if (relationshipId === null) {
    return "The supersession id does not fit the id rules.";
  }
  return {
    acceptance: "accepted",
    relationshipId,
    projectId: submission.projectId,
    relationshipType: "SUPERSEDES",
    fromId: next.fact.factId,
    toId: previousFactId,
    provenance: next.fact.provenance,
    validity: { from: next.fact.validity.from, until: null },
    acceptedBy: submission.authorId,
    acceptedAt: provenanceAt(next.fact.provenance),
  };
};

const conflictIdFor = (submissionId: string, index: number): string | null =>
  contractId(`conflict-${submissionId}-${index}`);

const publish = (
  ledger: MemoryLedgerV1,
  submission: SubmissionV1,
  plan: PublishPlan,
): Effect.Effect<MemoryLedgerV1, ContractTransitionError> =>
  Effect.gen(function* () {
    let graph = ledger.graph;
    if (plan.mode === "accepted") {
      for (const item of plan.facts) {
        graph = yield* applyMemoryEvent(graph, { type: "propose_fact", fact: item.fact });
        graph = yield* applyMemoryEvent(graph, {
          type: "accept_fact",
          factId: item.fact.factId,
          acceptedBy: submission.authorId,
          acceptedAt: provenanceAt(item.fact.provenance),
        });
      }
      for (const [index, replacement] of plan.replacements.entries()) {
        const edge = supersedesEdge(
          submission,
          replacement.next,
          replacement.previous.factId,
          index,
        );
        if (typeof edge === "string") {
          return yield* invalid(edge);
        }
        graph = yield* applyMemoryEvent(graph, { type: "supersede", relationship: edge });
      }
      const extra = plan.relationships.map((relationship) =>
        acceptRelationship(relationship, submission.authorId),
      );
      if (extra.length > 0) {
        graph = yield* decodeMemoryGraphV1({
          facts: graph.facts,
          relationships: [...graph.relationships, ...extra],
        });
      }
    } else {
      for (const item of plan.facts) {
        graph = yield* applyMemoryEvent(graph, { type: "propose_fact", fact: item.fact });
      }
      if (plan.relationships.length > 0) {
        graph = yield* decodeMemoryGraphV1({
          facts: graph.facts,
          relationships: [...graph.relationships, ...plan.relationships],
        });
      }
    }
    const identities = [
      ...ledger.identities,
      ...plan.facts.map((item) => ({
        factId: item.fact.factId,
        identity: item.identity,
        projectId: submission.projectId,
      })),
    ];
    const revisions = ledger.revisions.map((revision) =>
      plan.replacements.some((item) => item.previous.factId === revision.factId)
        ? { ...revision, current: false }
        : revision,
    );
    if (plan.mode === "accepted") {
      for (const item of plan.facts) {
        const replaced = plan.replacements.find(
          (replacement) => replacement.next.fact.factId === item.fact.factId,
        );
        revisions.push({
          factId: item.fact.factId,
          identity: item.identity,
          projectId: submission.projectId,
          revision: replaced === undefined ? 1 : replaced.previous.revision + 1,
          current: true,
        });
      }
    }
    const conflictRecords: MemoryConflictV1[] = [];
    for (const [index, conflict] of plan.conflicts.entries()) {
      const conflictId = conflictIdFor(submission.submissionId, index);
      if (conflictId === null) {
        return yield* invalid("The conflict id does not fit the id rules.");
      }
      const accepted = factById(ledger.graph, conflict.accepted.factId);
      conflictRecords.push({
        conflictId,
        projectId: submission.projectId,
        submissionId: submission.submissionId,
        authorId: submission.authorId,
        acceptedAuthorId: authorOf(accepted),
        taskId: submission.taskId,
        attemptId: submission.attemptId,
        identity: conflict.proposed.identity,
        acceptedFactId: conflict.accepted.factId,
        proposedFactId: conflict.proposed.fact.factId,
        resolvedBySubmissionId: null,
      });
    }
    const conflicts =
      plan.mode === "accepted"
        ? ledger.conflicts.map((conflict) =>
            conflict.resolvedBySubmissionId === null &&
            plan.replacements.some(
              (replacement) =>
                replacement.previous.projectId === conflict.projectId &&
                (replacement.previous.factId === conflict.acceptedFactId ||
                  replacement.previous.identity === conflict.identity),
            )
              ? { ...conflict, resolvedBySubmissionId: submission.submissionId }
              : conflict,
          )
        : [...ledger.conflicts, ...conflictRecords];
    return {
      graph,
      revisions,
      identities,
      conflicts,
      receipts: ledger.receipts,
    };
  });

export const applySubmission = (
  ledger: unknown,
  submission: unknown,
  acceptingAuthorId: string,
): Effect.Effect<SubmissionResultV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decodedLedger = yield* decodeLedger(ledger).pipe(
      Effect.mapError(() => invalid("The memory ledger does not match the schema.")),
    );
    const decodedSubmission = yield* decodeSubmission(submission).pipe(
      Effect.mapError(() => invalid("The submission does not match the schema.")),
    );
    const stored = decodedLedger.receipts.find(
      (receipt) => receipt.idempotencyKey === decodedSubmission.idempotencyKey,
    );
    if (stored !== undefined) {
      const receipt = yield* duplicateReceipt(stored);
      return yield* finish(decodedLedger, receipt);
    }
    const problem = structuralProblems(decodedLedger, decodedSubmission, acceptingAuthorId);
    if (problem !== null) {
      return yield* reject(decodedLedger, decodedSubmission, problem);
    }
    const plan = planSubmission(decodedLedger, decodedSubmission);
    if (typeof plan === "string") {
      return yield* reject(decodedLedger, decodedSubmission, plan);
    }
    const published = yield* publish(decodedLedger, decodedSubmission, plan).pipe(
      Effect.mapError((error) =>
        error.reason === "invalid_payload"
          ? error
          : invalid("The submission does not fit the memory graph."),
      ),
    );
    const factIds = plan.facts.map((item) => item.fact.factId);
    const relationshipIds = [
      ...plan.relationships.map((relationship) => relationship.relationshipId),
      ...published.graph.relationships
        .filter(
          (relationship) =>
            relationship.relationshipType === "SUPERSEDES" &&
            relationship.provenance.actorId === decodedSubmission.authorId &&
            factIds.includes(relationship.fromId) &&
            !plan.relationships.some((item) => item.relationshipId === relationship.relationshipId),
        )
        .map((relationship) => relationship.relationshipId),
    ];
    const conflictIds =
      plan.mode === "conflict"
        ? published.conflicts
            .filter((conflict) => conflict.submissionId === decodedSubmission.submissionId)
            .map((conflict) => conflict.conflictId)
        : [];
    const receipt: SubmissionReceiptV1 = {
      version: "v1",
      submissionId: decodedSubmission.submissionId,
      idempotencyKey: decodedSubmission.idempotencyKey,
      projectId: decodedSubmission.projectId,
      authorId: decodedSubmission.authorId,
      taskId: decodedSubmission.taskId,
      attemptId: decodedSubmission.attemptId,
      evidence: decodedSubmission.evidence,
      expectedVersions: decodedSubmission.expectedVersions,
      outcome:
        plan.mode === "accepted" ? "accepted" : plan.mode === "conflict" ? "conflict" : "pending",
      detail: plan.detail,
      factIds,
      relationshipIds,
      conflictIds,
      originalSubmissionId: null,
    };
    const next: MemoryLedgerV1 = {
      ...published,
      receipts: [...published.receipts, receipt],
    };
    return yield* finish(freezeSnapshot(next), receipt);
  });

export const decodeSubmissionV1 = decodeSubmission;
export const decodeMemoryLedgerV1 = decodeLedger;
export const decodeSubmissionReceiptV1 = decodeReceipt;
