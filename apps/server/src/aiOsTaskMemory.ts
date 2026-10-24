// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous, and the read receipt is stored beside the ledger.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import {
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
    package_json TEXT NOT NULL,
    write_token TEXT
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
  const columns = database.prepare("PRAGMA table_info(ai_os_memory_read)").all() as ReadonlyArray<{
    name?: string;
  }>;
  if (!columns.some((column) => column.name === "write_token")) {
    database.exec("ALTER TABLE ai_os_memory_read ADD COLUMN write_token TEXT");
  }
};

/** Token supplied in this attempt's launch prompt. A stored token wins. */
export const attemptWriteTokenSync = (
  database: NodeSqlite.DatabaseSync,
  attemptId: string,
): string => {
  prepareReads(database);
  const row = database
    .prepare("SELECT write_token FROM ai_os_memory_read WHERE attempt_id = ?")
    .get(attemptId) as { write_token?: string | null } | undefined;
  if (typeof row?.write_token === "string" && row.write_token.length > 0) return row.write_token;
  return `wt-${NodeCrypto.randomBytes(16).toString("hex")}`;
};

const storedWriteToken = (database: NodeSqlite.DatabaseSync, attemptId: string): string | null => {
  prepareReads(database);
  const row = database
    .prepare("SELECT write_token FROM ai_os_memory_read WHERE attempt_id = ?")
    .get(attemptId) as { write_token?: string | null } | undefined;
  return typeof row?.write_token === "string" && row.write_token.length > 0
    ? row.write_token
    : null;
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
  writeToken?: string,
): PreparedTaskMemory => {
  prepareReads(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = storedRead(database, prepared.receipt.attemptId);
    if (existing !== null) {
      if (writeToken !== undefined) {
        database
          .prepare(
            `UPDATE ai_os_memory_read
             SET write_token = ?
             WHERE attempt_id = ? AND write_token IS NULL`,
          )
          .run(writeToken, prepared.receipt.attemptId);
      }
      database.exec("COMMIT");
      return existing;
    }
    database
      .prepare(
        `INSERT INTO ai_os_memory_read
          (attempt_id, receipt_id, project_id, task_id, author_id, runtime, digest, receipt_json, package_json, write_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        writeToken ?? null,
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

/**
 * The attempt's own project and launch token.
 * The write stays a proposal. This does not accept it.
 */
export const submitAttemptMemorySync = (
  database: NodeSqlite.DatabaseSync,
  attemptId: string,
  projectId: string,
  write: unknown,
  acceptingAuthorId: string,
  writeToken: string,
): SubmissionReceiptV1 => {
  const activity = readAttemptActivitySync(database).find((item) => item.attemptId === attemptId);
  if (activity === undefined) {
    throw invalid("Context was not supplied for this attempt.");
  }
  if (activity.projectId !== projectId) {
    throw invalid("A fact stays inside the attempt's project.");
  }
  const token = storedWriteToken(database, attemptId);
  if (token === null || token !== writeToken) {
    throw invalid("This write token belongs to a different attempt.");
  }
  return recordTaskWriteSync(database, attemptId, write, acceptingAuthorId);
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
