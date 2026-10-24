// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous, and the directory has to exist before that connection opens.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  applySubmission,
  ContractTransitionError,
  decodeMemoryLedgerV1,
  initialMemoryLedger,
  type MemoryLedgerV1,
  type SubmissionReceiptV1,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Publication log for ai_os submissions.
 *
 * TAM 14.9.0 personal mode stores memory.db in WAL (synchronous NORMAL,
 * busy_timeout 5000). A disposable probe showed save, update, and relation
 * each commit on their own; knowledge has no revision or idempotency key;
 * two concurrent updates left two active rows; and kg_add_fact closed the
 * previous value instead of keeping a conflict. An exact repeat of
 * memory_save replaced the row. This table is the publication record those
 * calls do not provide. It lives in the same memory.db. Accepted knowledge
 * is not copied into TAM's knowledge rows, so a TAM save cannot retire it.
 * The path does not call TAM's quality gate or contradiction detector, so it
 * does not need the ollama provider configured on a personal install.
 * Event rows store the receipt. The current ledger is one snapshot row,
 * replaced in the same transaction.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_os_memory_event (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    submission_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    receipt_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_os_memory_snapshot (
    id INTEGER PRIMARY KEY,
    ledger_json TEXT NOT NULL
  );
`;

export const memoryDatabasePath = (env: NodeJS.ProcessEnv, homeDirectory: string): string => {
  const configured = env.TAM_MEMORY_DIR;
  const directory =
    configured !== undefined && configured.trim() !== ""
      ? configured
      : NodePath.join(homeDirectory, ".tam");
  return NodePath.join(directory, "memory.db");
};

const invalid = (detail: string) =>
  new ContractTransitionError({
    contract: "memory",
    reason: "invalid_payload",
    from: "idle",
    event: "submit",
    detail,
  });

const isContractTransitionError = Schema.is(ContractTransitionError);

const isConstraint = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("UNIQUE constraint failed");

const readLedger = (database: NodeSqlite.DatabaseSync): MemoryLedgerV1 => {
  const row = database
    .prepare("SELECT ledger_json FROM ai_os_memory_snapshot WHERE id = 1")
    .get() as { ledger_json?: string } | undefined;
  if (row?.ledger_json === undefined) {
    return initialMemoryLedger;
  }
  return Effect.runSync(
    decodeMemoryLedgerV1(JSON.parse(row.ledger_json)).pipe(
      Effect.mapError(() => invalid("The stored memory ledger does not match the schema.")),
    ),
  );
};

const rollback = (database: NodeSqlite.DatabaseSync) => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction is already closed.
  }
};

export const openMemoryDatabase = (filePath: string): NodeSqlite.DatabaseSync => {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(filePath, { timeout: 5_000 });
  database.exec("PRAGMA busy_timeout=5000");
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=NORMAL");
  database.exec(SCHEMA);
  return database;
};

export const readMemoryLedger = (database: NodeSqlite.DatabaseSync): MemoryLedgerV1 =>
  readLedger(database);

/**
 * One immediate transaction. A rejected or duplicate submission writes nothing.
 * Any other outcome inserts the receipt and replaces the single ledger snapshot.
 */
export const submitMemorySync = (
  database: NodeSqlite.DatabaseSync,
  submission: unknown,
  acceptingAuthorId: string,
): SubmissionReceiptV1 => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const ledger = readLedger(database);
    const result = Effect.runSync(applySubmission(ledger, submission, acceptingAuthorId));
    if (result.receipt.outcome === "rejected" || result.receipt.outcome === "duplicate") {
      database.exec("ROLLBACK");
      return result.receipt;
    }
    database
      .prepare(
        `INSERT INTO ai_os_memory_event
          (idempotency_key, submission_id, project_id, outcome, receipt_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        result.receipt.idempotencyKey,
        result.receipt.submissionId,
        result.receipt.projectId,
        result.receipt.outcome,
        JSON.stringify(result.receipt),
      );
    database
      .prepare(
        `INSERT INTO ai_os_memory_snapshot (id, ledger_json)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET ledger_json = excluded.ledger_json`,
      )
      .run(JSON.stringify(result.ledger));
    database.exec("COMMIT");
    return result.receipt;
  } catch (error) {
    rollback(database);
    if (isConstraint(error)) {
      const ledger = readLedger(database);
      const key =
        typeof submission === "object" &&
        submission !== null &&
        "idempotencyKey" in submission &&
        typeof submission.idempotencyKey === "string"
          ? submission.idempotencyKey
          : undefined;
      const stored = ledger.receipts.find((receipt) => receipt.idempotencyKey === key);
      if (stored !== undefined) {
        return Effect.runSync(applySubmission(ledger, submission, acceptingAuthorId)).receipt;
      }
    }
    if (isContractTransitionError(error)) {
      throw error;
    }
    throw invalid("The memory database could not record the submission.");
  }
};

export const submitMemory = (
  database: NodeSqlite.DatabaseSync,
  submission: unknown,
  acceptingAuthorId: string,
): Effect.Effect<SubmissionReceiptV1, ContractTransitionError> =>
  Effect.try({
    try: () => submitMemorySync(database, submission, acceptingAuthorId),
    catch: (error) => (isContractTransitionError(error) ? error : invalid(String(error))),
  });
