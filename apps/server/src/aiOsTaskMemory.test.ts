// @effect-diagnostics nodeBuiltinImport:off - The test opens a temp sqlite file and reopens it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { orientationText, packageFacts } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import { openMemoryDatabase, readMemoryLedger, submitMemory } from "./aiOsMemory.ts";
import { readAttemptActivitySync, recordTaskWrite, supplyTaskMemory } from "./aiOsTaskMemory.ts";

const at = "2026-10-24T06:00:00Z";
const commit = "b".repeat(40);
const authority = "jim";

const temporaryFile = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ai-os-task-memory-"));
  return NodePath.join(directory, "memory.db");
};

const request = (runtime: "codex" | "cursor" | "antigravity", attemptId: string) => ({
  projectId: "usba",
  taskId: "task-page",
  attemptId,
  authorId:
    runtime === "cursor" ? "cursor" : runtime === "antigravity" ? "antigravity" : "codex-t3",
  runtime,
  repoCommit: commit,
  requirements: "Publish the accepted start time.",
  authorizationScope: "usba-web",
  createdAt: at,
});

const decision = {
  version: "v1" as const,
  submissionId: "submission-start",
  idempotencyKey: "key-start",
  projectId: "usba",
  authorId: authority,
  taskId: "task-seed",
  attemptId: "attempt-seed",
  evidence: [{ evidenceId: "evidence-start", note: "The schedule file says so." }],
  expectedVersions: [] as ReadonlyArray<{ factId: string; revision: number }>,
  intent: "accept" as const,
  facts: [
    {
      identity: "tournament-start",
      fact: {
        acceptance: "proposed" as const,
        factId: "fact-start",
        projectId: "usba",
        kind: "Decision" as const,
        body: "Saturday games start at 7:00.",
        provenance: { actorId: authority, at },
        validity: { from: at, until: null },
      },
    },
  ],
  relationships: [],
};

it.effect("records a read and a write for each runtime, and reopens them", () =>
  Effect.gen(function* () {
    const file = temporaryFile();
    const database = openMemoryDatabase(file);
    yield* submitMemory(database, decision, authority);
    const supplied = [];
    for (const runtime of ["codex", "cursor", "antigravity"] as const) {
      const prepared = yield* supplyTaskMemory(database, request(runtime, `attempt-${runtime}`));
      supplied.push(prepared);
      assert.strictEqual(prepared.receipt.runtime, runtime);
      assert.strictEqual(
        prepared.receipt.authorId,
        request(runtime, `attempt-${runtime}`).authorId,
      );
      assert.deepStrictEqual(
        prepared.package.orientation.decisions.map((line) => line.factId),
        ["fact-start"],
      );
      const earlier = supplied.slice(0, -1);
      assert.deepStrictEqual(
        [...prepared.receipt.memoryVersions].sort(),
        ["fact-start", ...earlier.map((item) => `fact-lesson-${item.receipt.runtime}`)].sort(),
      );
      assert.deepStrictEqual(
        prepared.package.orientation.proposals.map((line) => line.body),
        earlier.map((item) => `Lesson from ${item.receipt.runtime}.`),
      );
      assert.strictEqual(
        prepared.package.orientation.proposals.every((line) =>
          orientationText(prepared.package).includes(`proposed, not accepted: ${line.body}`),
        ),
        true,
      );
      const receipt = yield* recordTaskWrite(
        database,
        prepared.receipt.attemptId,
        {
          kind: "findings",
          facts: [
            {
              identity: `lesson-${runtime}`,
              fact: {
                acceptance: "proposed",
                factId: `fact-lesson-${runtime}`,
                projectId: "usba",
                kind: "Procedure",
                body: `Lesson from ${runtime}.`,
                provenance: { actorId: prepared.receipt.authorId, at },
                validity: { from: at, until: null },
              },
            },
          ],
          relationships: [],
          evidence: [{ evidenceId: `evidence-${runtime}`, note: "The run finished the page." }],
        },
        authority,
      );
      assert.strictEqual(receipt.outcome, "pending");
      assert.strictEqual(receipt.authorId, prepared.receipt.authorId);
    }
    const changed = yield* supplyTaskMemory(database, {
      ...request("codex", "attempt-codex"),
      requirements: "A later request must not replace the supplied package.",
    });
    assert.strictEqual(changed.receipt.digest, supplied[0]?.receipt.digest);
    assert.strictEqual(changed.package.requirements, "Publish the accepted start time.");
    database.close();

    const reopened = openMemoryDatabase(file);
    const activity = readAttemptActivitySync(reopened);
    assert.deepStrictEqual(activity.map((item) => item.runtime).sort(), [
      "antigravity",
      "codex",
      "cursor",
    ]);
    assert.strictEqual(
      activity.every((item) => item.write?.outcome === "pending" && item.authorId.length > 0),
      true,
    );
    const ledger = readMemoryLedger(reopened);
    assert.strictEqual(
      packageFacts(ledger.graph, "usba", at).some((fact) => fact.factId.startsWith("fact-lesson")),
      false,
    );
    reopened.close();
    NodeFS.rmSync(NodePath.dirname(file), { recursive: true, force: true });
  }),
);
