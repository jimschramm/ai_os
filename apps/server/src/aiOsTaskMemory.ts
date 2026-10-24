// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous, and the read receipt is stored beside the ledger.
import * as NodeSqlite from "node:sqlite";

import {
  contentDigest,
  ContractTransitionError,
  decodeAttemptMemoryActivityV1,
  decodeContextPackageSnapshotV1,
  decodeReadReceiptV1,
  decodeTaskMemoryPackageV1,
  prepareTaskMemory,
  taskWriteSubmission,
  type AttemptMemoryActivityV1,
  type PreparedTaskMemory,
  type ReadReceiptV1,
  type SubmissionReceiptV1,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { openMemoryDatabase, readMemoryLedger, submitMemorySync } from "./aiOsMemory.ts";

const READ_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_os_memory_read (
    attempt_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    runtime TEXT NOT NULL,
    digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    package_json TEXT NOT NULL
  );
`;

const invalid = (detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event: "submit",
    detail,
  });

const isContractTransitionError = Schema.is(ContractTransitionError);

const rollback = (database: NodeSqlite.DatabaseSync) => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction is already closed.
  }
};

const prepareReads = (database: NodeSqlite.DatabaseSync) => {
  database.exec(READ_SCHEMA);
};

const storedRead = (
  database: NodeSqlite.DatabaseSync,
  attemptId: string,
): PreparedTaskMemory | null => {
  const row = database
    .prepare("SELECT receipt_json, package_json FROM ai_os_memory_read WHERE attempt_id = ?")
    .get(attemptId) as { receipt_json?: string; package_json?: string } | undefined;
  if (row?.receipt_json === undefined || row.package_json === undefined) return null;
  const receipt = Effect.runSync(decodeReadReceiptV1(JSON.parse(row.receipt_json)));
  const memoryPackage = Effect.runSync(decodeTaskMemoryPackageV1(JSON.parse(row.package_json)));
  const contextPackage = Effect.runSync(
    decodeContextPackageSnapshotV1({
      requirements: memoryPackage.requirements,
      memoryVersions: memoryPackage.memoryVersions,
      repoCommit: memoryPackage.repoCommit,
      authorizationScope: memoryPackage.authorizationScope,
      createdAt: memoryPackage.createdAt,
    }),
  );
  return { package: memoryPackage, receipt, contextPackage };
};

/** Build the package for this attempt. An existing row wins, and nothing is written. */
export const prepareTaskMemorySync = (
  database: NodeSqlite.DatabaseSync,
  request: unknown,
): PreparedTaskMemory => {
  prepareReads(database);
  const prepared = Effect.runSync(prepareTaskMemory(readMemoryLedger(database), request));
  return storedRead(database, prepared.receipt.attemptId) ?? prepared;
};

/**
 * Store a package that was already placed in the launch input.
 * A second commit returns the row from the first launch.
 */
export const commitTaskReadSync = (
  database: NodeSqlite.DatabaseSync,
  prepared: PreparedTaskMemory,
): PreparedTaskMemory => {
  prepareReads(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = storedRead(database, prepared.receipt.attemptId);
    if (existing !== null) {
      database.exec("ROLLBACK");
      return existing;
    }
    database
      .prepare(
        `INSERT INTO ai_os_memory_read
          (attempt_id, receipt_id, project_id, task_id, author_id, runtime, digest, receipt_json, package_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prepared.receipt.attemptId,
        prepared.receipt.receiptId,
        prepared.receipt.projectId,
        prepared.receipt.taskId,
        prepared.receipt.authorId,
        prepared.receipt.runtime,
        prepared.receipt.digest,
        JSON.stringify(prepared.receipt),
        JSON.stringify(prepared.package),
      );
    database.exec("COMMIT");
    return prepared;
  } catch (error) {
    rollback(database);
    if (isContractTransitionError(error)) throw error;
    throw invalid("The memory database could not record the read receipt.");
  }
};

/** Prepare and commit. Callers that launch must commit only after the prompt includes the package. */
export const supplyTaskMemorySync = (
  database: NodeSqlite.DatabaseSync,
  request: unknown,
): PreparedTaskMemory => commitTaskReadSync(database, prepareTaskMemorySync(database, request));

export const recordTaskWriteSync = (
  database: NodeSqlite.DatabaseSync,
  attemptId: string,
  write: unknown,
  acceptingAuthorId: string,
): SubmissionReceiptV1 => {
  prepareReads(database);
  const stored = storedRead(database, attemptId);
  if (stored === null) {
    throw invalid("Context was not supplied for this attempt.");
  }
  const submission = Effect.runSync(
    taskWriteSubmission(readMemoryLedger(database), stored.receipt, write),
  );
  return submitMemorySync(database, submission, acceptingAuthorId);
};

const fitId = (prefix: string, key: string): string => {
  const joined = `${prefix}-${key}`;
  if (joined.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(joined)) return joined;
  return `${prefix}-${contentDigest(key)}`;
};

const isRecordedFact = (
  write: unknown,
): write is { readonly kind: "fact"; readonly identity: string } =>
  typeof write === "object" &&
  write !== null &&
  "kind" in write &&
  write.kind === "fact" &&
  "identity" in write &&
  typeof write.identity === "string";

/**
 * A later run only reads accepted facts. A new recorded fact is accepted by
 * the authority. Findings stay proposed, and a contradiction is already a conflict.
 */
const acceptRecordedFactSync = (
  database: NodeSqlite.DatabaseSync,
  receipt: SubmissionReceiptV1,
  write: unknown,
  acceptingAuthorId: string,
): void => {
  if (receipt.outcome !== "pending" || receipt.factIds.length !== 1) return;
  if (!isRecordedFact(write)) return;
  const proposedId = receipt.factIds[0];
  if (proposedId === undefined) return;
  const ledger = readMemoryLedger(database);
  const proposed = ledger.graph.facts.find((fact) => fact.factId === proposedId);
  const identity = ledger.identities.find((item) => item.factId === proposedId);
  if (proposed === undefined || identity === undefined || identity.identity !== write.identity) {
    return;
  }
  const current = ledger.revisions.find(
    (revision) =>
      revision.current &&
      revision.identity === identity.identity &&
      revision.projectId === receipt.projectId,
  );
  if (current !== undefined) return;
  const factId = fitId("known", proposedId);
  const key = fitId("accept", proposedId);
  const accepted = submitMemorySync(
    database,
    {
      version: "v1",
      submissionId: key,
      idempotencyKey: key,
      projectId: receipt.projectId,
      authorId: acceptingAuthorId,
      taskId: receipt.taskId,
      attemptId: fitId("accept", receipt.attemptId),
      evidence: receipt.evidence,
      expectedVersions: [],
      intent: "accept",
      facts: [
        {
          identity: identity.identity,
          fact: {
            acceptance: "proposed",
            factId,
            projectId: receipt.projectId,
            kind: proposed.kind,
            body: proposed.body,
            provenance: { actorId: acceptingAuthorId, at: proposed.provenance.at },
            validity: { from: proposed.validity.from, until: null },
          },
        },
      ],
      relationships: [],
    },
    acceptingAuthorId,
  );
  if (accepted.outcome !== "accepted" && accepted.outcome !== "duplicate") {
    throw invalid(accepted.detail);
  }
};

/** The attempt's own project. A recorded fact with no current statement is then accepted. */
export const submitAttemptMemorySync = (
  database: NodeSqlite.DatabaseSync,
  attemptId: string,
  projectId: string,
  write: unknown,
  acceptingAuthorId: string,
): SubmissionReceiptV1 => {
  const activity = readAttemptActivitySync(database).find((item) => item.attemptId === attemptId);
  if (activity === undefined) {
    throw invalid("Context was not supplied for this attempt.");
  }
  if (activity.projectId !== projectId) {
    throw invalid("A fact stays inside the attempt's project.");
  }
  const receipt = recordTaskWriteSync(database, attemptId, write, acceptingAuthorId);
  acceptRecordedFactSync(database, receipt, write, acceptingAuthorId);
  return receipt;
};

const writeFor = (
  database: NodeSqlite.DatabaseSync,
  receipt: ReadReceiptV1,
): AttemptMemoryActivityV1["write"] => {
  const ledger = readMemoryLedger(database);
  const match = ledger.receipts.find(
    (item) => item.attemptId === receipt.attemptId && item.outcome !== "duplicate",
  );
  if (match === undefined) return null;
  return {
    submissionId: match.submissionId,
    outcome: match.outcome,
    detail: match.detail,
    factIds: match.factIds,
  };
};

export const readAttemptActivitySync = (
  database: NodeSqlite.DatabaseSync,
): readonly AttemptMemoryActivityV1[] => {
  prepareReads(database);
  const rows = database
    .prepare("SELECT receipt_json FROM ai_os_memory_read ORDER BY attempt_id")
    .all();
  return rows.flatMap((row) => {
    const receiptJson = row.receipt_json;
    if (typeof receiptJson !== "string") return [];
    const receipt = Effect.runSync(decodeReadReceiptV1(JSON.parse(receiptJson)));
    return [
      Effect.runSync(
        decodeAttemptMemoryActivityV1({
          projectId: receipt.projectId,
          taskId: receipt.taskId,
          attemptId: receipt.attemptId,
          authorId: receipt.authorId,
          runtime: receipt.runtime,
          read: {
            receiptId: receipt.receiptId,
            digest: receipt.digest,
            suppliedAt: receipt.suppliedAt,
            memoryVersions: receipt.memoryVersions,
          },
          write: writeFor(database, receipt),
        }),
      ),
    ];
  });
};

export const supplyTaskMemory = (
  database: NodeSqlite.DatabaseSync,
  request: unknown,
): Effect.Effect<PreparedTaskMemory, ContractTransitionError> =>
  Effect.try({
    try: () => supplyTaskMemorySync(database, request),
    catch: (error) => (isContractTransitionError(error) ? error : invalid(String(error))),
  });

export const withTaskMemory = <A>(
  file: string,
  body: (database: NodeSqlite.DatabaseSync) => A,
): Effect.Effect<A, ContractTransitionError> =>
  Effect.try({
    try: () => {
      const database = openMemoryDatabase(file);
      try {
        return body(database);
      } finally {
        database.close();
      }
    },
    catch: (error) => (isContractTransitionError(error) ? error : invalid(String(error))),
  });

export const recordTaskWrite = (
  database: NodeSqlite.DatabaseSync,
  attemptId: string,
  write: unknown,
  acceptingAuthorId: string,
): Effect.Effect<SubmissionReceiptV1, ContractTransitionError> =>
  Effect.try({
    try: () => recordTaskWriteSync(database, attemptId, write, acceptingAuthorId),
    catch: (error) => (isContractTransitionError(error) ? error : invalid(String(error))),
  });
