// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous, matching the memory publication path.
import * as NodeSqlite from "node:sqlite";

import {
  contentDigest,
  ContractTransitionError,
  type SubmissionReceiptV1,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readMemoryLedger, submitMemorySync } from "./aiOsMemory.ts";

const ACCEPTING_AUTHORITY = "jim";

const invalid = (detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event: "submit",
    detail,
  });

const isContractTransitionError = Schema.is(ContractTransitionError);

const fitId = (prefix: string, key: string): string => {
  const joined = `${prefix}-${key}`;
  if (joined.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(joined)) return joined;
  return `${prefix}-${contentDigest(key)}`;
};

export type MemoryResolutionAction = "keep" | "accept" | "correct";

const noteFor = (action: MemoryResolutionAction): string => {
  if (action === "keep") return "Jim kept the accepted statement.";
  if (action === "accept") return "Jim accepted the proposed statement.";
  return "Jim corrected the statement.";
};

/**
 * Resolve one open conflict through SubmissionV1.
 * Keep leaves the accepted fact. Accept and correct publish a new accepted version.
 */
export const resolveMemoryConflictSync = (
  database: NodeSqlite.DatabaseSync,
  input: {
    readonly action: MemoryResolutionAction;
    readonly conflictId: string;
    readonly body?: string | undefined;
    readonly createdAt: string;
  },
): SubmissionReceiptV1 => {
  const ledger = readMemoryLedger(database);
  const conflict = ledger.conflicts.find(
    (item) => item.conflictId === input.conflictId && item.resolvedBySubmissionId === null,
  );
  if (conflict === undefined) {
    throw invalid("That conflict is not open.");
  }
  const accepted = ledger.graph.facts.find((fact) => fact.factId === conflict.acceptedFactId);
  const proposed = ledger.graph.facts.find((fact) => fact.factId === conflict.proposedFactId);
  if (accepted === undefined || accepted.acceptance === "proposed") {
    throw invalid("The accepted fact is missing.");
  }
  const revision = ledger.revisions.find((item) => item.factId === accepted.factId && item.current);
  if (revision === undefined) {
    throw invalid("The accepted fact has no current revision.");
  }
  const statement =
    input.action === "keep"
      ? accepted.body
      : input.action === "accept"
        ? proposed?.body
        : input.body?.trim();
  if (statement === undefined || statement.length === 0) {
    throw invalid("The resolution needs the statement to keep.");
  }
  const key = fitId(
    `resolve-${input.action}`,
    input.action === "correct"
      ? `${conflict.conflictId}-${contentDigest(statement)}`
      : conflict.conflictId,
  );
  const submission = {
    version: "v1",
    submissionId: key,
    idempotencyKey: key,
    projectId: conflict.projectId,
    authorId: ACCEPTING_AUTHORITY,
    taskId: conflict.taskId,
    attemptId: conflict.attemptId,
    evidence: [{ evidenceId: fitId("evidence", conflict.conflictId), note: noteFor(input.action) }],
    expectedVersions: [{ factId: accepted.factId, revision: revision.revision }],
    intent: "accept",
    facts: [
      {
        identity: conflict.identity,
        fact: {
          acceptance: "proposed",
          factId: fitId(`fact-${input.action}`, key),
          projectId: conflict.projectId,
          kind: accepted.kind,
          body: statement,
          provenance: { actorId: ACCEPTING_AUTHORITY, at: input.createdAt },
          validity: { from: input.createdAt, until: null },
        },
      },
    ],
    relationships: [],
  };
  return submitMemorySync(database, submission, ACCEPTING_AUTHORITY);
};

export const resolveMemoryConflict = (
  database: NodeSqlite.DatabaseSync,
  input: {
    readonly action: MemoryResolutionAction;
    readonly conflictId: string;
    readonly body?: string | undefined;
    readonly createdAt: string;
  },
): Effect.Effect<SubmissionReceiptV1, ContractTransitionError> =>
  Effect.try({
    try: () => resolveMemoryConflictSync(database, input),
    catch: (error) => (isContractTransitionError(error) ? error : invalid(String(error))),
  });
