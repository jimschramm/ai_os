// @effect-diagnostics nodeBuiltinImport:off - The race opens real sqlite files from worker threads.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  memoryDatabasePath,
  openMemoryDatabase,
  readMemoryLedger,
  submitMemory,
} from "./aiOsMemory.ts";

const at = "2026-10-24T06:00:00Z";
const authority = "jim";

const submission = (id: string, body: string, intent: "propose" | "accept" = "propose") => ({
  version: "v1" as const,
  submissionId: `submission-${id}`,
  idempotencyKey: `key-${id}`,
  projectId: "probe",
  authorId: intent === "accept" ? authority : "codex-t3",
  taskId: "task-probe",
  attemptId: "attempt-1",
  evidence: [{ evidenceId: `evidence-${id}`, note: "Throwaway probe evidence." }],
  expectedVersions: [] as ReadonlyArray<{ factId: string; revision: number }>,
  intent,
  facts: [
    {
      identity: "tournament-start",
      fact: {
        acceptance: "proposed" as const,
        factId: `fact-${id}`,
        projectId: "probe",
        kind: "Decision" as const,
        body,
        provenance: { actorId: intent === "accept" ? authority : "codex-t3", at },
        validity: { from: at, until: null },
      },
    },
    {
      identity: "schedule-source",
      fact: {
        acceptance: "proposed" as const,
        factId: `source-${id}`,
        projectId: "probe",
        kind: "Source" as const,
        body: "Throwaway source.",
        provenance: { actorId: intent === "accept" ? authority : "codex-t3", at },
        validity: { from: at, until: null },
      },
    },
  ],
  relationships: [
    {
      acceptance: "proposed" as const,
      relationshipId: `rel-${id}`,
      projectId: "probe",
      relationshipType: "SUPPORTED_BY" as const,
      fromId: `fact-${id}`,
      toId: `source-${id}`,
      provenance: { actorId: intent === "accept" ? authority : "codex-t3", at },
      validity: { from: at, until: null },
    },
  ],
});

it.effect("resolves the memory file inside TAM's directory", () =>
  Effect.sync(() => {
    assert.strictEqual(
      memoryDatabasePath({ TAM_MEMORY_DIR: "/tmp/tam-probe" }, "/home/jim"),
      "/tmp/tam-probe/memory.db",
    );
    assert.strictEqual(memoryDatabasePath({}, "/home/jim"), "/home/jim/.tam/memory.db");
  }),
);

const temporaryFile = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ai-os-memory-"));
  return NodePath.join(directory, "memory.db");
};

it.effect("publishes a fact and its relationship in one committed batch", () =>
  Effect.gen(function* () {
    const file = temporaryFile();
    const database = openMemoryDatabase(file);
    const receipt = yield* submitMemory(
      database,
      submission("batch", "Saturday games start at 7:00.", "accept"),
      authority,
    );
    assert.strictEqual(receipt.outcome, "accepted");
    assert.deepStrictEqual(receipt.factIds, ["fact-batch", "source-batch"]);
    assert.ok(receipt.relationshipIds.includes("rel-batch"));
    database.close();

    const reopened = openMemoryDatabase(file);
    const ledger = readMemoryLedger(reopened);
    assert.strictEqual(ledger.graph.facts.length, 2);
    assert.ok(ledger.graph.relationships.some((item) => item.relationshipId === "rel-batch"));
    assert.strictEqual(
      ledger.graph.facts.find((fact) => fact.factId === "fact-batch")?.provenance.actorId,
      authority,
    );
    reopened.exec("BEGIN IMMEDIATE");
    reopened
      .prepare(
        "INSERT INTO ai_os_memory_event (idempotency_key, submission_id, project_id, outcome, receipt_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run("rolled-back", "rolled-back", "probe", "pending", "{}");
    reopened.exec("ROLLBACK");
    reopened.close();

    const afterRollback = openMemoryDatabase(file);
    const rows = afterRollback
      .prepare("SELECT COUNT(*) AS count FROM ai_os_memory_event")
      .get() as {
      count: number;
    };
    assert.strictEqual(rows.count, 1);
    afterRollback.close();
    NodeFS.rmSync(NodePath.dirname(file), { recursive: true, force: true });
  }),
);

it.effect("treats a repeated idempotency key as one write", () =>
  Effect.gen(function* () {
    const file = temporaryFile();
    const database = openMemoryDatabase(file);
    const first = yield* submitMemory(
      database,
      submission("once", "Saturday games start at 7:00."),
      authority,
    );
    const second = yield* submitMemory(
      database,
      { ...submission("once", "Saturday games start at 9:00."), submissionId: "submission-other" },
      authority,
    );
    assert.strictEqual(first.outcome, "pending");
    assert.strictEqual(second.outcome, "duplicate");
    assert.strictEqual(second.originalSubmissionId, "submission-once");
    const rows = database.prepare("SELECT COUNT(*) AS count FROM ai_os_memory_event").get() as {
      count: number;
    };
    assert.strictEqual(rows.count, 1);
    const ledger = readMemoryLedger(database);
    assert.strictEqual(
      ledger.graph.facts.find((fact) => fact.factId === "fact-once")?.body,
      "Saturday games start at 7:00.",
    );
    database.close();
    NodeFS.rmSync(NodePath.dirname(file), { recursive: true, force: true });
  }),
);

it.effect("keeps the accepted decision when two writers race", () =>
  Effect.gen(function* () {
    const file = temporaryFile();
    const database = openMemoryDatabase(file);
    yield* submitMemory(
      database,
      submission("base", "Saturday games start at 7:00.", "accept"),
      authority,
    );
    database.close();
    const moduleUrl = NodeURL.pathToFileURL(
      NodePath.join(import.meta.dirname, "aiOsMemory.ts"),
    ).href;
    const run = (id: string, body: string) =>
      new Promise<{ outcome: string; body: string }>((resolve, reject) => {
        const worker = new NodeWorkerThreads.Worker(
          `
            const { parentPort, workerData } = require("node:worker_threads");
            import(workerData.moduleUrl).then((memory) => {
              const database = memory.openMemoryDatabase(workerData.file);
              try {
                const receipt = memory.submitMemorySync(database, workerData.submission, workerData.authority);
                parentPort.postMessage({ outcome: receipt.outcome });
              } finally {
                database.close();
              }
            }).catch((error) => {
              parentPort.postMessage({ error: String(error && error.stack ? error.stack : error) });
            });
          `,
          {
            eval: true,
            execArgv: ["--experimental-strip-types"],
            workerData: {
              moduleUrl,
              file,
              authority,
              submission: {
                ...submission(id, body, "accept"),
                expectedVersions: [{ factId: "fact-base", revision: 1 }],
                facts: [
                  {
                    identity: "tournament-start",
                    fact: {
                      acceptance: "proposed",
                      factId: `fact-${id}`,
                      projectId: "probe",
                      kind: "Decision",
                      body,
                      provenance: { actorId: authority, at },
                      validity: { from: at, until: null },
                    },
                  },
                ],
                relationships: [],
              },
            },
          },
        );
        worker.once("message", (message: { outcome?: string; error?: string }) => {
          if (message.error !== undefined) {
            reject(new Error(message.error));
            return;
          }
          resolve({ outcome: message.outcome ?? "", body });
        });
        worker.once("error", reject);
      });
    const raced = yield* Effect.promise(() =>
      Promise.all([run("a", "Race writer A."), run("b", "Race writer B.")]),
    );
    const outcomes = raced.map((item) => item.outcome).sort();
    assert.deepStrictEqual(outcomes, ["accepted", "conflict"]);
    const checked = openMemoryDatabase(file);
    const ledger = readMemoryLedger(checked);
    const current = ledger.graph.facts.filter((fact) => fact.acceptance === "accepted");
    const bodies = new Set(current.map((fact) => fact.body));
    assert.strictEqual(current.length, 2);
    assert.strictEqual(bodies.has("Saturday games start at 7:00."), false);
    const winner = raced.find((item) => item.outcome === "accepted");
    if (winner === undefined) {
      return yield* Effect.die("One of the two writers has to be accepted.");
    }
    assert.strictEqual(bodies.has(winner.body), true);
    assert.ok(ledger.conflicts.some((conflict) => conflict.resolvedBySubmissionId === null));
    checked.close();
    NodeFS.rmSync(NodePath.dirname(file), { recursive: true, force: true });
  }),
);

const decision = (
  id: string,
  body: string,
  intent: "propose" | "accept",
  expectedFactId: string | null,
) => ({
  version: "v1" as const,
  submissionId: `submission-${id}`,
  idempotencyKey: `key-${id}`,
  projectId: "probe",
  authorId: intent === "accept" ? authority : "codex-t3",
  taskId: "task-probe",
  attemptId: "attempt-1",
  evidence: [{ evidenceId: `evidence-${id}`, note: "Throwaway probe evidence." }],
  expectedVersions: expectedFactId === null ? [] : [{ factId: expectedFactId, revision: 1 }],
  intent,
  facts: [
    {
      identity: "tournament-start",
      fact: {
        acceptance: "proposed" as const,
        factId: `fact-${id}`,
        projectId: "probe",
        kind: "Decision" as const,
        body,
        provenance: { actorId: intent === "accept" ? authority : "codex-t3", at },
        validity: { from: at, until: null },
      },
    },
  ],
  relationships: [] as [],
});

it.effect("records a conflict when the text matches but the expected revision is stale", () =>
  Effect.gen(function* () {
    const file = temporaryFile();
    const database = openMemoryDatabase(file);
    yield* submitMemory(
      database,
      decision("rev1", "Saturday games start at 7:00.", "accept", null),
      authority,
    );
    const replaced = yield* submitMemory(
      database,
      decision("rev2", "Saturday games start at 8:30.", "accept", "fact-rev1"),
      authority,
    );
    assert.strictEqual(replaced.outcome, "accepted");
    const receipt = yield* submitMemory(
      database,
      decision("stale", "Saturday games start at 8:30.", "propose", "fact-rev1"),
      authority,
    );
    assert.strictEqual(receipt.outcome, "conflict");
    database.close();

    const reopened = openMemoryDatabase(file);
    const ledger = readMemoryLedger(reopened);
    const stored = ledger.receipts.find((item) => item.submissionId === "submission-stale");
    const conflict = ledger.conflicts.find((item) => item.submissionId === "submission-stale");
    assert.strictEqual(stored?.outcome, "conflict");
    assert.strictEqual(conflict?.authorId, "codex-t3");
    assert.strictEqual(conflict?.acceptedFactId, "fact-rev2");
    assert.strictEqual(conflict?.proposedFactId, "fact-stale");
    assert.strictEqual(conflict?.resolvedBySubmissionId, null);
    assert.strictEqual(
      ledger.graph.facts.find((fact) => fact.factId === "fact-rev2")?.acceptance,
      "accepted",
    );
    assert.strictEqual(
      ledger.graph.facts.find((fact) => fact.factId === "fact-rev2")?.body,
      "Saturday games start at 8:30.",
    );
    reopened.close();
    NodeFS.rmSync(NodePath.dirname(file), { recursive: true, force: true });
  }),
);

it.effect("persists two concurrent submissions", () =>
  Effect.gen(function* () {
    const file = temporaryFile();
    const prepared = openMemoryDatabase(file);
    prepared.close();
    const moduleUrl = NodeURL.pathToFileURL(
      NodePath.join(import.meta.dirname, "aiOsMemory.ts"),
    ).href;
    const run = (id: string, body: string) =>
      new Promise<string>((resolve, reject) => {
        const worker = new NodeWorkerThreads.Worker(
          `
            const { parentPort, workerData } = require("node:worker_threads");
            import(workerData.moduleUrl).then((memory) => {
              const database = memory.openMemoryDatabase(workerData.file);
              try {
                const receipt = memory.submitMemorySync(database, workerData.submission, workerData.authority);
                parentPort.postMessage({ outcome: receipt.outcome });
              } finally {
                database.close();
              }
            }).catch((error) => {
              parentPort.postMessage({ error: String(error && error.stack ? error.stack : error) });
            });
          `,
          {
            eval: true,
            execArgv: ["--experimental-strip-types"],
            workerData: {
              moduleUrl,
              file,
              authority,
              submission: submission(id, body),
            },
          },
        );
        worker.once("message", (message: { outcome?: string; error?: string }) => {
          if (message.error !== undefined) {
            reject(new Error(message.error));
            return;
          }
          resolve(message.outcome ?? "");
        });
        worker.once("error", reject);
      });
    const outcomes = yield* Effect.promise(() =>
      Promise.all([run("one", "Finding one."), run("two", "Finding two.")]),
    );
    assert.deepStrictEqual(outcomes.slice().sort(), ["pending", "pending"]);
    const checked = openMemoryDatabase(file);
    const ledger = readMemoryLedger(checked);
    const ids = new Set(ledger.receipts.map((item) => item.submissionId));
    assert.strictEqual(ids.has("submission-one"), true);
    assert.strictEqual(ids.has("submission-two"), true);
    const events = checked.prepare("SELECT COUNT(*) AS count FROM ai_os_memory_event").get() as {
      count: number;
    };
    const snapshots = checked
      .prepare("SELECT COUNT(*) AS count FROM ai_os_memory_snapshot")
      .get() as { count: number };
    assert.strictEqual(events.count, 2);
    assert.strictEqual(snapshots.count, 1);
    checked.close();
    NodeFS.rmSync(NodePath.dirname(file), { recursive: true, force: true });
  }),
);
