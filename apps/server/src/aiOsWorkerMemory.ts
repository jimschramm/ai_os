// @effect-diagnostics nodeBuiltinImport:off - node:sqlite and node:crypto match the other memory paths.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import {
  acceptProposedFact,
  ContractTransitionError,
  decodeProjectMemoryPolicyV1,
  decodeWorkerAcceptV1,
  decodeWorkerProposeV1,
  decodeWorkerRegistrationV1,
  disabledPolicy,
  policyAcceptsFact,
  prepareTaskMemory,
  taskWriteSubmission,
  workerContextPackage,
  type ProjectMemoryPolicyV1,
  type SubmissionReceiptV1,
  type WorkerContextPackageV1,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import { isLoopbackAddress, isLoopbackBindHost } from "./auth/loopbackTrust.ts";
import { readMemoryLedger, saveMemoryLedgerSync, submitMemorySync } from "./aiOsMemory.ts";

const ACCEPTING_AUTHORITY = "jim";
const TOKEN_PATTERN = /^lw-[0-9a-f]{64}$/;

export const WORKER_SCOPE_DETAIL = "This worker token is scoped to a different project.";
export const WORKER_LOCAL_DETAIL = "Worker memory is only available on localhost.";
export const WORKER_TOKEN_DETAIL = "This worker token is not registered.";
export const WORKER_TAKEN_DETAIL = "That worker is already registered for another project.";

const WORKER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_os_memory_worker (
    worker_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_os_memory_policy (
    project_id TEXT PRIMARY KEY,
    policy_json TEXT NOT NULL
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

export interface WorkerPrincipal {
  readonly workerId: string;
  readonly projectId: string;
}

export interface WorkerRegistrationResult {
  readonly schemaVersion: "v1";
  readonly workerId: string;
  readonly projectId: string;
  readonly runtime: "local-worker";
  readonly token: string;
  readonly rotated: boolean;
}

export interface WorkerProposeResult {
  readonly schemaVersion: "v1";
  readonly outcome: SubmissionReceiptV1["outcome"];
  readonly autoAccepted: boolean;
  readonly detail: string;
  readonly submissionId: string;
  readonly factIds: readonly string[];
  readonly conflictIds: readonly string[];
}

const prepareWorkerTables = (database: NodeSqlite.DatabaseSync) => {
  database.exec(WORKER_SCHEMA);
};

const tokenHash = (token: string): string =>
  NodeCrypto.createHash("sha256").update(token).digest("hex");

const hostnameFromHost = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  if (first === undefined || first.length === 0) return undefined;
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    return end > 1 ? first.slice(1, end) : undefined;
  }
  const colon = first.lastIndexOf(":");
  if (colon > 0 && first.indexOf(":") === colon && /^\d+$/.test(first.slice(colon + 1))) {
    return first.slice(0, colon);
  }
  return first;
};

/**
 * The worker token is a localhost credential. Host has to be loopback, and a
 * reported peer or forwarded client that is not loopback is refused. A missing
 * peer is allowed so an in-process call on a loopback Host still works.
 */
export const localWorkerHttpAllowed = (input: {
  readonly host: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly forwardedFor: string | undefined;
}): boolean => {
  const host = hostnameFromHost(input.host);
  if (!isLoopbackBindHost(host)) return false;
  if (input.remoteAddress !== undefined && !isLoopbackAddress(input.remoteAddress)) return false;
  if (input.forwardedFor === undefined || input.forwardedFor.trim() === "") return true;
  const peers = input.forwardedFor
    .split(",")
    .map((part) => hostnameFromHost(part) ?? "")
    .filter((part) => part.length > 0);
  return peers.length > 0 && peers.every((peer) => isLoopbackAddress(peer));
};

export const workerTokenFromAuthorization = (authorization: string | undefined): string | null => {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];
  if (token === undefined || !TOKEN_PATTERN.test(token)) return null;
  return token;
};

export const registerWorkerSync = (
  database: NodeSqlite.DatabaseSync,
  body: unknown,
  createdAt: string,
): WorkerRegistrationResult => {
  prepareWorkerTables(database);
  const decoded = Effect.runSync(
    decodeWorkerRegistrationV1(body).pipe(
      Effect.mapError(() => invalid("The worker registration does not match the schema.")),
    ),
  );
  const existing = database
    .prepare("SELECT project_id FROM ai_os_memory_worker WHERE worker_id = ?")
    .get(decoded.workerId) as { project_id?: string } | undefined;
  if (existing !== undefined && existing.project_id !== decoded.projectId) {
    throw invalid(WORKER_TAKEN_DETAIL);
  }
  const token = `lw-${NodeCrypto.randomBytes(32).toString("hex")}`;
  const hash = tokenHash(token);
  if (existing === undefined) {
    database
      .prepare(
        `INSERT INTO ai_os_memory_worker (worker_id, project_id, token_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(decoded.workerId, decoded.projectId, hash, createdAt);
  } else {
    database
      .prepare(
        `UPDATE ai_os_memory_worker
         SET token_hash = ?, created_at = ?
         WHERE worker_id = ? AND project_id = ?`,
      )
      .run(hash, createdAt, decoded.workerId, decoded.projectId);
  }
  return {
    schemaVersion: "v1",
    workerId: decoded.workerId,
    projectId: decoded.projectId,
    runtime: "local-worker",
    token,
    rotated: existing !== undefined,
  };
};

export const authenticateWorkerSync = (
  database: NodeSqlite.DatabaseSync,
  token: string,
): WorkerPrincipal | null => {
  prepareWorkerTables(database);
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = database
    .prepare("SELECT worker_id, project_id FROM ai_os_memory_worker WHERE token_hash = ?")
    .get(tokenHash(token)) as { worker_id?: string; project_id?: string } | undefined;
  if (typeof row?.worker_id !== "string" || typeof row.project_id !== "string") return null;
  return { workerId: row.worker_id, projectId: row.project_id };
};

export const readPolicySync = (
  database: NodeSqlite.DatabaseSync,
  projectId: string,
): ProjectMemoryPolicyV1 | null => {
  prepareWorkerTables(database);
  const row = database
    .prepare("SELECT policy_json FROM ai_os_memory_policy WHERE project_id = ?")
    .get(projectId) as { policy_json?: string } | undefined;
  if (typeof row?.policy_json !== "string") return null;
  return Effect.runSync(
    decodeProjectMemoryPolicyV1(JSON.parse(row.policy_json)).pipe(
      Effect.mapError(() => invalid("The stored auto-accept policy does not match the schema.")),
    ),
  );
};

export const writePolicySync = (
  database: NodeSqlite.DatabaseSync,
  body: unknown,
): ProjectMemoryPolicyV1 => {
  prepareWorkerTables(database);
  const decoded = Effect.runSync(
    decodeProjectMemoryPolicyV1(body).pipe(
      Effect.mapError(() => invalid("The auto-accept policy does not match the schema.")),
    ),
  );
  database
    .prepare(
      `INSERT INTO ai_os_memory_policy (project_id, policy_json)
       VALUES (?, ?)
       ON CONFLICT(project_id) DO UPDATE SET policy_json = excluded.policy_json`,
    )
    .run(decoded.projectId, JSON.stringify(decoded));
  return decoded;
};

export const policyForOwnerSync = (
  database: NodeSqlite.DatabaseSync,
  projectId: string,
): ProjectMemoryPolicyV1 => readPolicySync(database, projectId) ?? disabledPolicy(projectId);

const trimmed = (value: unknown): unknown => (typeof value === "string" ? value.trim() : value);

export const readWorkerContextSync = (
  database: NodeSqlite.DatabaseSync,
  worker: WorkerPrincipal,
  query: {
    readonly schemaVersion: unknown;
    readonly projectId: unknown;
    readonly repoCommit: unknown;
    readonly requirements: unknown;
    readonly authorizationScope: unknown;
  },
  asOf: string,
): WorkerContextPackageV1 => {
  if (query.projectId !== worker.projectId) {
    throw invalid(WORKER_SCOPE_DETAIL);
  }
  return Effect.runSync(
    workerContextPackage(
      readMemoryLedger(database),
      {
        schemaVersion: trimmed(query.schemaVersion),
        projectId: trimmed(query.projectId),
        repoCommit: trimmed(query.repoCommit),
        requirements: trimmed(query.requirements),
        authorizationScope: trimmed(query.authorizationScope),
        asOf,
      },
      worker.workerId,
    ),
  );
};

const proposeResult = (
  receipt: SubmissionReceiptV1,
  autoAccepted: boolean,
  outcome: SubmissionReceiptV1["outcome"] = receipt.outcome,
  detail = receipt.detail,
): WorkerProposeResult => ({
  schemaVersion: "v1",
  outcome,
  autoAccepted,
  detail,
  submissionId: receipt.submissionId,
  factIds: receipt.factIds,
  conflictIds: receipt.conflictIds,
});

/**
 * Record a proposal for this worker's project. The submission intent is propose.
 * Auto-accept runs only after a clean pending proposal, and only for a saved policy.
 * A conflict stays a conflict for the steward.
 */
export const proposeWorkerMemorySync = (
  database: NodeSqlite.DatabaseSync,
  worker: WorkerPrincipal,
  body: unknown,
  asOf: string,
): WorkerProposeResult => {
  const decoded = Effect.runSync(
    decodeWorkerProposeV1(body).pipe(
      Effect.mapError(() => invalid("The worker proposal does not match the schema.")),
    ),
  );
  if (decoded.projectId !== worker.projectId || decoded.workerId !== worker.workerId) {
    throw invalid(WORKER_SCOPE_DETAIL);
  }
  const authorId = decoded.provenanceActorId ?? worker.workerId;
  const prepared = Effect.runSync(
    prepareTaskMemory(readMemoryLedger(database), {
      projectId: worker.projectId,
      taskId: decoded.taskId,
      attemptId: decoded.attemptId,
      authorId,
      runtime: "local-worker",
      repoCommit: "0".repeat(40),
      requirements: "Local worker proposal.",
      authorizationScope: `project:${worker.projectId}`,
      createdAt: asOf,
    }),
  );
  const submission = Effect.runSync(
    taskWriteSubmission(readMemoryLedger(database), prepared.receipt, decoded.write),
  );
  const receipt = submitMemorySync(database, submission, ACCEPTING_AUTHORITY);
  if (receipt.outcome !== "pending") return proposeResult(receipt, false);
  const policy = readPolicySync(database, worker.projectId);
  let ledger = readMemoryLedger(database);
  const acceptedIds: string[] = [];
  for (const factId of receipt.factIds) {
    const fact = ledger.graph.facts.find((item) => item.factId === factId);
    if (fact === undefined || fact.acceptance !== "proposed" || !policyAcceptsFact(policy, fact)) {
      continue;
    }
    ledger = Effect.runSync(
      acceptProposedFact(ledger, {
        factId,
        projectId: worker.projectId,
        acceptedBy: ACCEPTING_AUTHORITY,
        acceptedAt: asOf,
      }),
    );
    acceptedIds.push(factId);
  }
  if (acceptedIds.length === 0) return proposeResult(receipt, false);
  saveMemoryLedgerSync(
    database,
    ledger,
    acceptedIds.map((factId) => ({
      idempotencyKey: `accept-${factId}`,
      submissionId: `accept-${factId}`,
      projectId: worker.projectId,
      outcome: "accepted",
      receipt: {
        schemaVersion: "v1",
        type: "accept_fact",
        factId,
        projectId: worker.projectId,
        acceptedBy: ACCEPTING_AUTHORITY,
        acceptedAt: asOf,
        source: "policy",
      },
    })),
  );
  const allAccepted = receipt.factIds.every((factId) => acceptedIds.includes(factId));
  return proposeResult(
    receipt,
    true,
    allAccepted ? "accepted" : "pending",
    allAccepted ? "Accepted by the project policy." : receipt.detail,
  );
};

export const acceptFactForOwnerSync = (
  database: NodeSqlite.DatabaseSync,
  body: unknown,
  acceptedAt: string,
): { readonly factId: string; readonly projectId: string } => {
  const decoded = Effect.runSync(
    decodeWorkerAcceptV1(body).pipe(
      Effect.mapError(() => invalid("The acceptance does not match the schema.")),
    ),
  );
  const ledger = Effect.runSync(
    acceptProposedFact(readMemoryLedger(database), {
      factId: decoded.factId,
      projectId: decoded.projectId,
      acceptedBy: ACCEPTING_AUTHORITY,
      acceptedAt,
    }),
  );
  saveMemoryLedgerSync(database, ledger, [
    {
      idempotencyKey: `accept-${decoded.factId}`,
      submissionId: `accept-${decoded.factId}`,
      projectId: decoded.projectId,
      outcome: "accepted",
      receipt: {
        schemaVersion: "v1",
        type: "accept_fact",
        factId: decoded.factId,
        projectId: decoded.projectId,
        acceptedBy: ACCEPTING_AUTHORITY,
        acceptedAt,
        source: "explicit",
      },
    },
  ]);
  return { factId: decoded.factId, projectId: decoded.projectId };
};

export const workerCallFailed = (
  error: ContractTransitionError,
): { readonly status: 400 | 403 | 409; readonly detail: string } => ({
  status:
    error.detail === WORKER_SCOPE_DETAIL
      ? 403
      : error.detail.includes("does not match the schema")
        ? 400
        : 409,
  detail: error.message,
});
