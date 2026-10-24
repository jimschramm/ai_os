import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ContextPackageSnapshotV1,
  declaredTaskType,
  decodeContextPackageSnapshotV1,
  freezeSnapshot,
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
  MemoryNodeKindV1,
  packageFacts,
  packageProposals,
  ProposedRelationshipV1,
  type MemoryFactV1,
} from "./memory.ts";
import {
  type ExpectedFactVersionV1,
  type MemoryLedgerV1,
  SourceEvidenceV1,
  SubmissionOutcomeV1,
  SubmissionV1,
} from "./submission.ts";

export const TaskRuntimeV1 = Schema.Literals(["codex", "cursor", "antigravity"]);
export type TaskRuntimeV1 = typeof TaskRuntimeV1.Type;

export const TaskMemoryRequestV1 = Schema.Struct({
  projectId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  authorId: ContractId,
  runtime: TaskRuntimeV1,
  repoCommit: GitSha,
  requirements: ContractText,
  authorizationScope: ContractText,
  createdAt: IsoDateTime,
});
export type TaskMemoryRequestV1 = typeof TaskMemoryRequestV1.Type;

export const OrientationLineV1 = Schema.Struct({
  factId: ContractId,
  kind: MemoryNodeKindV1,
  body: ContractText,
  actorId: ContractId,
});
export type OrientationLineV1 = typeof OrientationLineV1.Type;

export const ConflictOrientationV1 = Schema.Struct({
  conflictId: ContractId,
  identity: ContractId,
  acceptedFactId: ContractId,
  proposedFactId: ContractId,
  acceptedBody: ContractText,
  proposedBody: ContractText,
  authorId: ContractId,
  acceptedAuthorId: ContractId,
});
export type ConflictOrientationV1 = typeof ConflictOrientationV1.Type;

export const ArtifactSummaryV1 = Schema.Struct({
  factId: ContractId,
  summary: ContractText,
  actorId: ContractId,
});
export type ArtifactSummaryV1 = typeof ArtifactSummaryV1.Type;

const lineList = Schema.Array(OrientationLineV1);

export const TaskMemoryPackageV1 = Schema.Struct({
  version: ContractVersion,
  projectId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  authorId: ContractId,
  runtime: TaskRuntimeV1,
  repoCommit: GitSha,
  requirements: ContractText,
  authorizationScope: ContractText,
  createdAt: IsoDateTime,
  digest: ContractId,
  memoryVersions: Schema.Array(ContractId),
  orientation: Schema.Struct({
    instructions: lineList,
    decisions: lineList,
    knowledge: lineList,
    conflicts: Schema.Array(ConflictOrientationV1),
    proposals: Schema.Array(OrientationLineV1).pipe(
      Schema.withDecodingDefault(Effect.sync(() => [] as ReadonlyArray<OrientationLineV1>)),
    ),
  }),
  detail: lineList,
  summaries: Schema.Array(ArtifactSummaryV1),
});
export type TaskMemoryPackageV1 = typeof TaskMemoryPackageV1.Type;

export const ReadReceiptV1 = Schema.Struct({
  version: ContractVersion,
  receiptId: ContractId,
  projectId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  authorId: ContractId,
  runtime: TaskRuntimeV1,
  digest: ContractId,
  memoryVersions: Schema.Array(ContractId),
  suppliedAt: IsoDateTime,
});
export type ReadReceiptV1 = typeof ReadReceiptV1.Type;

export const AttemptWriteV1 = Schema.Struct({
  submissionId: ContractId,
  outcome: SubmissionOutcomeV1,
  detail: ContractText,
  factIds: Schema.Array(ContractId),
});
export type AttemptWriteV1 = typeof AttemptWriteV1.Type;

export const AttemptMemoryActivityV1 = Schema.Struct({
  projectId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  authorId: ContractId,
  runtime: TaskRuntimeV1,
  read: Schema.Struct({
    receiptId: ContractId,
    digest: ContractId,
    suppliedAt: IsoDateTime,
    memoryVersions: Schema.Array(ContractId),
  }),
  write: Schema.NullOr(AttemptWriteV1),
});
export type AttemptMemoryActivityV1 = typeof AttemptMemoryActivityV1.Type;

const evidenceList = Schema.Array(SourceEvidenceV1).check(
  Schema.makeFilter((items: ReadonlyArray<SourceEvidenceV1>) =>
    items.length > 0 ? true : "A submission needs source evidence.",
  ),
);

const proposedFact = Schema.Struct({
  identity: ContractId,
  fact: Schema.Struct({
    acceptance: Schema.Literal("proposed"),
    factId: ContractId,
    projectId: ContractId,
    kind: MemoryNodeKindV1,
    body: ContractText,
    provenance: Schema.Struct({ actorId: ContractId, at: IsoDateTime }),
    validity: Schema.Struct({ from: IsoDateTime, until: Schema.NullOr(IsoDateTime) }),
  }),
});

export const TaskWriteV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("findings"),
    facts: Schema.NonEmptyArray(proposedFact),
    relationships: Schema.Array(ProposedRelationshipV1),
    evidence: evidenceList,
  }),
  Schema.Struct({
    kind: Schema.Literal("fact"),
    identity: ContractId,
    nodeKind: MemoryNodeKindV1,
    body: ContractText,
    evidence: evidenceList,
  }),
  Schema.Struct({
    kind: Schema.Literal("no_durable_change"),
    explanation: ContractText,
    evidence: evidenceList,
  }),
]);
export type TaskWriteV1 = typeof TaskWriteV1.Type;

const decodeRequest = Schema.decodeUnknownEffect(TaskMemoryRequestV1, strictParse);
const decodePackage = Schema.decodeUnknownEffect(TaskMemoryPackageV1, strictParse);
const decodeReceipt = Schema.decodeUnknownEffect(ReadReceiptV1, strictParse);
const decodeWrite = Schema.decodeUnknownEffect(TaskWriteV1, strictParse);
const decodeSubmission = Schema.decodeUnknownEffect(SubmissionV1, strictParse);

const invalid = (detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event: "submit",
    detail,
  });

const fnv = (value: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Stable digest of the supplied text. It identifies the package. It is not a token budget. */
export const contentDigest = (value: string): string =>
  [0x811c9dc5, 0x811c9dc5 ^ 0x9e3779b9, 0x811c9dc5 ^ 0x85ebca6b, 0x811c9dc5 ^ 0xc2b2ae35]
    .map((seed) => fnv(value, seed).toString(16).padStart(8, "0"))
    .join("");

const prefixedId = (prefix: string, attemptId: string): string => {
  const joined = `${prefix}-${attemptId}`;
  if (joined.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(joined)) return joined;
  return `${prefix}-${contentDigest(attemptId)}`;
};

const lineFrom = (fact: MemoryFactV1): OrientationLineV1 => ({
  factId: fact.factId,
  kind: fact.kind,
  body: fact.body,
  actorId: fact.provenance.actorId,
});

const summaryOf = (body: string): string => {
  const first = body.split("\n")[0]?.trim() ?? "";
  return first.length > 0 ? first : body.trim();
};

const byKind = (facts: ReadonlyArray<MemoryFactV1>, kind: MemoryNodeKindV1): OrientationLineV1[] =>
  facts.filter((fact) => fact.kind === kind).map(lineFrom);

export const runtimeForAssignment = (assignment: {
  readonly instanceId?: string | undefined;
  readonly taskType?: "implementation" | "advisory" | undefined;
  readonly role?: "implementer" | "qa" | "advisory" | undefined;
}): TaskRuntimeV1 => {
  if (declaredTaskType(assignment) === "advisory" || assignment.instanceId === "antigravity") {
    return "antigravity";
  }
  if (assignment.instanceId === "cursor") return "cursor";
  return "codex";
};

/** Compact lines for the run. Artifact logs stay in `detail`; this list uses their summary. */
export const orientationText = (memoryPackage: TaskMemoryPackageV1): readonly string[] => [
  ...memoryPackage.orientation.instructions.map((line) => line.body),
  ...memoryPackage.orientation.decisions.map((line) => line.body),
  ...memoryPackage.orientation.knowledge.map((line) => line.body),
  ...memoryPackage.orientation.conflicts.map(
    (conflict) =>
      `Open conflict ${conflict.conflictId}: ${conflict.acceptedBody} / ${conflict.proposedBody} (${conflict.authorId})`,
  ),
  ...memoryPackage.orientation.proposals.map((line) => `proposed, not accepted: ${line.body}`),
  ...memoryPackage.summaries.map((item) => item.summary),
];

/**
 * True when the text the runtime will see contains this package.
 * A receipt is stored only after this is true for the launch input.
 */
export const promptCarriesMemory = (memoryPackage: TaskMemoryPackageV1, prompt: string): boolean =>
  prompt.includes(memoryPackage.requirements) &&
  prompt.includes(memoryPackage.repoCommit) &&
  orientationText(memoryPackage).every((line) => prompt.includes(line));

/**
 * Lines appended to the launch prompt the same way the memory package is.
 * A fresh agent has to see its own attempt, project, and the write shapes.
 */
export const taskWritePrompt = (
  memoryPackage: TaskMemoryPackageV1,
  writePath: string,
  writeToken: string,
): readonly string[] => [
  `Memory write: POST ${writePath} for attempt ${memoryPackage.attemptId} in project ${memoryPackage.projectId}.`,
  `Memory write token: ${writeToken}`,
  `Record a fact: {"attemptId":"${memoryPackage.attemptId}","writeToken":"${writeToken}","write":{"kind":"fact","identity":"<identity>","nodeKind":"Decision","body":"<statement>","evidence":[{"evidenceId":"<id>","note":"<source>"}]}}`,
  `Propose findings: {"attemptId":"${memoryPackage.attemptId}","writeToken":"${writeToken}","write":{"kind":"findings","facts":[{"identity":"<identity>","fact":{"acceptance":"proposed","factId":"<id>","projectId":"${memoryPackage.projectId}","kind":"Decision","body":"<statement>","provenance":{"actorId":"${memoryPackage.authorId}","at":"${memoryPackage.createdAt}"},"validity":{"from":"${memoryPackage.createdAt}","until":null}}}],"relationships":[],"evidence":[{"evidenceId":"<id>","note":"<source>"}]}}`,
  "This attempt has one write. A stale or contradictory proposal is kept as a conflict for the Memory Steward.",
];

export interface PreparedTaskMemory {
  readonly package: TaskMemoryPackageV1;
  readonly receipt: ReadReceiptV1;
  readonly contextPackage: ContextPackageSnapshotV1;
}

export const prepareTaskMemory = (
  ledger: MemoryLedgerV1,
  request: unknown,
): Effect.Effect<PreparedTaskMemory, ContractTransitionError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeRequest(request).pipe(
      Effect.mapError(() => invalid("The task memory request does not match the schema.")),
    );
    const current = packageFacts(ledger.graph, decoded.projectId, decoded.createdAt);
    const pendingProposals = packageProposals(
      ledger.graph,
      decoded.projectId,
      decoded.createdAt,
    ).filter((fact) => {
      const named = ledger.identities.find(
        (item) => item.factId === fact.factId && item.projectId === decoded.projectId,
      );
      if (named === undefined) return true;
      return !ledger.revisions.some(
        (revision) =>
          revision.current &&
          revision.identity === named.identity &&
          revision.projectId === decoded.projectId,
      );
    });
    const artifacts = current.filter((fact) => fact.kind === "Artifact");
    const knowledge = current.filter(
      (fact) => fact.kind !== "Instruction" && fact.kind !== "Decision" && fact.kind !== "Artifact",
    );
    const conflicts = ledger.conflicts.flatMap((conflict) => {
      if (conflict.projectId !== decoded.projectId || conflict.resolvedBySubmissionId !== null) {
        return [];
      }
      const accepted = ledger.graph.facts.find((fact) => fact.factId === conflict.acceptedFactId);
      const proposed = ledger.graph.facts.find((fact) => fact.factId === conflict.proposedFactId);
      if (accepted === undefined || proposed === undefined) return [];
      return [
        {
          conflictId: conflict.conflictId,
          identity: conflict.identity,
          acceptedFactId: conflict.acceptedFactId,
          proposedFactId: conflict.proposedFactId,
          acceptedBody: accepted.body,
          proposedBody: proposed.body,
          authorId: conflict.authorId,
          acceptedAuthorId: conflict.acceptedAuthorId,
        },
      ];
    });
    const summaries = artifacts.map((fact) => ({
      factId: fact.factId,
      summary: summaryOf(fact.body),
      actorId: fact.provenance.actorId,
    }));
    const memoryVersions = [
      ...current.map((fact) => fact.factId),
      ...pendingProposals.map((fact) => fact.factId),
    ];
    const packaged = [...current, ...pendingProposals];
    const canonical = [
      decoded.projectId,
      decoded.taskId,
      decoded.attemptId,
      decoded.authorId,
      decoded.runtime,
      decoded.repoCommit,
      decoded.requirements,
      ...[...memoryVersions].sort().map((factId) => {
        const fact = packaged.find((item) => item.factId === factId);
        const standing = pendingProposals.some((item) => item.factId === factId)
          ? "proposed"
          : "accepted";
        return `${standing}\t${factId}\t${fact?.body ?? ""}`;
      }),
      ...conflicts.map(
        (conflict) => `${conflict.conflictId}\t${conflict.acceptedBody}\t${conflict.proposedBody}`,
      ),
      ...summaries.map((item) => `${item.factId}\t${item.summary}`),
    ].join("\n");
    const contextPackage = yield* decodeContextPackageSnapshotV1({
      requirements: decoded.requirements,
      memoryVersions,
      repoCommit: decoded.repoCommit,
      authorizationScope: decoded.authorizationScope,
      createdAt: decoded.createdAt,
    }).pipe(Effect.mapError(() => invalid("The context package does not match the schema.")));
    const memoryPackage = yield* decodePackage({
      version: "v1",
      projectId: decoded.projectId,
      taskId: decoded.taskId,
      attemptId: decoded.attemptId,
      authorId: decoded.authorId,
      runtime: decoded.runtime,
      repoCommit: decoded.repoCommit,
      requirements: decoded.requirements,
      authorizationScope: decoded.authorizationScope,
      createdAt: decoded.createdAt,
      digest: contentDigest(canonical),
      memoryVersions,
      orientation: {
        instructions: byKind(current, "Instruction"),
        decisions: byKind(current, "Decision"),
        knowledge: knowledge.map(lineFrom),
        conflicts,
        proposals: pendingProposals.map(lineFrom),
      },
      detail: current.map(lineFrom),
      summaries,
    }).pipe(Effect.mapError(() => invalid("The task memory package does not match the schema.")));
    const receipt = yield* decodeReceipt({
      version: "v1",
      receiptId: prefixedId("read", decoded.attemptId),
      projectId: decoded.projectId,
      taskId: decoded.taskId,
      attemptId: decoded.attemptId,
      authorId: decoded.authorId,
      runtime: decoded.runtime,
      digest: memoryPackage.digest,
      memoryVersions,
      suppliedAt: decoded.createdAt,
    }).pipe(Effect.mapError(() => invalid("The read receipt does not match the schema.")));
    return freezeSnapshot({ package: memoryPackage, receipt, contextPackage });
  });

const currentExpected = (
  ledger: MemoryLedgerV1,
  memoryVersions: ReadonlyArray<string>,
  projectId: string,
): ExpectedFactVersionV1[] =>
  memoryVersions.flatMap((factId) => {
    const revision = ledger.revisions.find(
      (item) => item.factId === factId && item.current && item.projectId === projectId,
    );
    return revision === undefined ? [] : [{ factId, revision: revision.revision }];
  });

/**
 * A run writes through SubmissionV1 as a proposal. The accepting authority is
 * not this agent. A recorded fact is one proposed fact. Findings stay proposed.
 */
export const taskWriteSubmission = (
  ledger: MemoryLedgerV1,
  receipt: ReadReceiptV1,
  write: unknown,
): Effect.Effect<SubmissionV1, ContractTransitionError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeWrite(write).pipe(
      Effect.mapError(() => invalid("The task write does not match the schema.")),
    );
    const facts =
      decoded.kind === "findings"
        ? decoded.facts
        : decoded.kind === "fact"
          ? [
              {
                identity: decoded.identity,
                fact: {
                  acceptance: "proposed" as const,
                  factId: prefixedId("fact", `${receipt.attemptId}-${decoded.identity}`),
                  projectId: receipt.projectId,
                  kind: decoded.nodeKind,
                  body: decoded.body,
                  provenance: { actorId: receipt.authorId, at: receipt.suppliedAt },
                  validity: { from: receipt.suppliedAt, until: null as string | null },
                },
              },
            ]
          : [
              {
                identity: prefixedId("unchanged", receipt.attemptId),
                fact: {
                  acceptance: "proposed" as const,
                  factId: prefixedId("note", receipt.attemptId),
                  projectId: receipt.projectId,
                  kind: "Source" as const,
                  body: decoded.explanation,
                  provenance: { actorId: receipt.authorId, at: receipt.suppliedAt },
                  validity: { from: receipt.suppliedAt, until: null as string | null },
                },
              },
            ];
    for (const item of facts) {
      if (item.fact.provenance.actorId !== receipt.authorId) {
        return yield* invalid("The fact author is the agent that read the context.");
      }
      if (item.fact.projectId !== receipt.projectId) {
        return yield* invalid("A fact stays inside the attempt's project.");
      }
    }
    return yield* decodeSubmission({
      version: "v1",
      submissionId: prefixedId("write", receipt.attemptId),
      idempotencyKey: prefixedId("write", receipt.attemptId),
      projectId: receipt.projectId,
      authorId: receipt.authorId,
      taskId: receipt.taskId,
      attemptId: receipt.attemptId,
      evidence: decoded.evidence,
      expectedVersions: currentExpected(ledger, receipt.memoryVersions, receipt.projectId),
      intent: "propose",
      facts,
      relationships: decoded.kind === "findings" ? decoded.relationships : [],
    }).pipe(
      Effect.mapError(() => invalid("The task write does not match the submission contract.")),
    );
  });

export const decodeTaskMemoryPackageV1 = decodePackage;
export const decodeReadReceiptV1 = decodeReceipt;
export const decodeAttemptMemoryActivityV1 = Schema.decodeUnknownEffect(
  AttemptMemoryActivityV1,
  strictParse,
);
