import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { packageFacts } from "./memory.ts";
import { applySubmission, initialMemoryLedger, type MemoryLedgerV1 } from "./submission.ts";
import {
  orientationText,
  prepareTaskMemory,
  runtimeForAssignment,
  taskWriteSubmission,
  type TaskMemoryRequestV1,
} from "./taskMemory.ts";

const at = "2026-10-24T06:00:00Z";
const commit = "a".repeat(40);
const authority = "jim";

const request = (
  runtime: TaskMemoryRequestV1["runtime"],
  attemptId = "attempt-1",
): TaskMemoryRequestV1 => ({
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

const fact = (
  ledger: MemoryLedgerV1,
  id: string,
  kind: "Instruction" | "Decision" | "Artifact" | "Procedure",
  body: string,
  authorId: string,
) =>
  applySubmission(
    ledger,
    {
      version: "v1",
      submissionId: `submission-${id}`,
      idempotencyKey: `key-${id}`,
      projectId: "usba",
      authorId,
      taskId: "task-seed",
      attemptId: "attempt-seed",
      evidence: [{ evidenceId: `evidence-${id}`, note: "Seeded for the package." }],
      expectedVersions: [],
      intent: "accept",
      facts: [
        {
          identity: `identity-${id}`,
          fact: {
            acceptance: "proposed",
            factId: `fact-${id}`,
            projectId: "usba",
            kind,
            body,
            provenance: { actorId: authorId, at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
    },
    authority,
  );

it.effect("supplies current memory to each runtime and keeps logs behind the summary", () =>
  Effect.gen(function* () {
    const instruction = yield* fact(
      initialMemoryLedger,
      "rule",
      "Instruction",
      "Publish only an accepted start time.",
      authority,
    );
    const decision = yield* fact(
      instruction.ledger,
      "start",
      "Decision",
      "Saturday games start at 7:00.",
      authority,
    );
    const logBody = `Publish log\n${"x".repeat(500)}`;
    const logged = yield* fact(decision.ledger, "log", "Artifact", logBody, authority);
    const conflicted = yield* applySubmission(
      logged.ledger,
      {
        version: "v1",
        submissionId: "submission-late",
        idempotencyKey: "key-late",
        projectId: "usba",
        authorId: "codex-t3",
        taskId: "task-seed",
        attemptId: "attempt-seed",
        evidence: [{ evidenceId: "evidence-late", note: "A later proposal." }],
        expectedVersions: [{ factId: "fact-start", revision: 1 }],
        intent: "propose",
        facts: [
          {
            identity: "identity-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-late",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 8:30.",
              provenance: { actorId: "codex-t3", at },
              validity: { from: at, until: null },
            },
          },
        ],
        relationships: [],
      },
      authority,
    );
    assert.strictEqual(runtimeForAssignment({ instanceId: "cursor" }), "cursor");
    assert.strictEqual(runtimeForAssignment({ taskType: "advisory" }), "antigravity");
    assert.strictEqual(runtimeForAssignment({ instanceId: "codex" }), "codex");

    for (const runtime of ["codex", "cursor", "antigravity"] as const) {
      const prepared = yield* prepareTaskMemory(conflicted.ledger, request(runtime));
      assert.strictEqual(prepared.receipt.runtime, runtime);
      assert.strictEqual(prepared.receipt.authorId, request(runtime).authorId);
      assert.strictEqual(
        prepared.package.orientation.instructions[0]?.body,
        "Publish only an accepted start time.",
      );
      assert.strictEqual(
        prepared.package.orientation.decisions[0]?.body,
        "Saturday games start at 7:00.",
      );
      assert.strictEqual(prepared.package.orientation.conflicts[0]?.authorId, "codex-t3");
      assert.strictEqual(prepared.package.summaries[0]?.summary, "Publish log");
      assert.strictEqual(
        prepared.package.detail.find((line) => line.factId === "fact-log")?.body,
        logBody,
      );
      const shown = orientationText(prepared.package).join("\n");
      assert.strictEqual(shown.includes("Publish only an accepted start time."), true);
      assert.strictEqual(shown.includes("x".repeat(500)), false);
      assert.deepStrictEqual(prepared.contextPackage.memoryVersions.includes("fact-start"), true);
      assert.strictEqual(
        prepared.package.orientation.proposals.some((line) => line.factId === "fact-late"),
        false,
      );
      assert.strictEqual(Object.isFrozen(prepared.package), true);
    }
    const again = yield* prepareTaskMemory(conflicted.ledger, request("codex"));
    const first = yield* prepareTaskMemory(conflicted.ledger, request("codex"));
    assert.strictEqual(again.receipt.digest, first.receipt.digest);
    assert.deepStrictEqual(
      packageFacts(conflicted.ledger.graph, "usba", at).some((item) => item.factId === "fact-late"),
      false,
    );
  }),
);

it.effect("writes findings as a proposal and does not accept a lesson", () =>
  Effect.gen(function* () {
    const accepted = yield* fact(
      initialMemoryLedger,
      "start",
      "Decision",
      "Saturday games start at 7:00.",
      authority,
    );
    const prepared = yield* prepareTaskMemory(accepted.ledger, request("codex"));
    const lesson = yield* taskWriteSubmission(accepted.ledger, prepared.receipt, {
      kind: "findings",
      facts: [
        {
          identity: "identity-lesson",
          fact: {
            acceptance: "proposed",
            factId: "fact-lesson",
            projectId: "usba",
            kind: "Procedure",
            body: "Check the schedule file before changing the start time.",
            provenance: { actorId: "codex-t3", at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
      evidence: [{ evidenceId: "evidence-lesson", note: "The run failed twice on the same page." }],
    });
    assert.strictEqual(lesson.intent, "propose");
    const stored = yield* applySubmission(accepted.ledger, lesson, authority);
    assert.strictEqual(stored.receipt.outcome, "pending");
    assert.strictEqual(
      stored.ledger.graph.facts.find((item) => item.factId === "fact-lesson")?.acceptance,
      "proposed",
    );
    assert.deepStrictEqual(
      packageFacts(stored.ledger.graph, "usba", at)
        .map((item) => item.factId)
        .includes("fact-lesson"),
      false,
    );

    const second = yield* prepareTaskMemory(accepted.ledger, request("codex", "attempt-2"));
    const quiet = yield* taskWriteSubmission(accepted.ledger, second.receipt, {
      kind: "no_durable_change",
      explanation: "The page already matched the accepted start time.",
      evidence: [{ evidenceId: "evidence-quiet", note: "Read the page and the decision." }],
    });
    assert.strictEqual(quiet.intent, "propose");
    assert.strictEqual(quiet.facts[0]?.fact.kind, "Source");
    const noted = yield* applySubmission(accepted.ledger, quiet, authority);
    assert.strictEqual(noted.receipt.outcome, "pending");
    assert.strictEqual(
      packageFacts(noted.ledger.graph, "usba", at).some((item) =>
        item.body.includes("already matched"),
      ),
      false,
    );
  }),
);

it.effect("records a fact as the agent's proposal inside the attempt project", () =>
  Effect.gen(function* () {
    const accepted = yield* fact(
      initialMemoryLedger,
      "start",
      "Decision",
      "Saturday games start at 7:00.",
      authority,
    );
    const prepared = yield* prepareTaskMemory(accepted.ledger, request("codex"));
    const submission = yield* taskWriteSubmission(accepted.ledger, prepared.receipt, {
      kind: "fact",
      identity: "page-check",
      nodeKind: "Procedure",
      body: "Check the schedule file before changing the start time.",
      evidence: [{ evidenceId: "evidence-fact", note: "The run read the schedule." }],
    });
    assert.strictEqual(submission.intent, "propose");
    assert.strictEqual(submission.projectId, "usba");
    assert.strictEqual(submission.authorId, prepared.receipt.authorId);
    assert.strictEqual(submission.attemptId, prepared.receipt.attemptId);
    assert.strictEqual(submission.facts[0]?.identity, "page-check");
    assert.strictEqual(submission.facts[0]?.fact.kind, "Procedure");
    assert.strictEqual(submission.facts[0]?.fact.projectId, "usba");
    assert.strictEqual(submission.facts[0]?.fact.provenance.actorId, prepared.receipt.authorId);
  }),
);

it.effect("keeps a pending proposal out of accepted knowledge and in the read receipt", () =>
  Effect.gen(function* () {
    const proposed = yield* applySubmission(
      initialMemoryLedger,
      {
        version: "v1",
        submissionId: "submission-pending",
        idempotencyKey: "key-pending",
        projectId: "usba",
        authorId: "codex-t3",
        taskId: "task-seed",
        attemptId: "attempt-seed",
        evidence: [{ evidenceId: "evidence-pending", note: "The agent recorded it." }],
        expectedVersions: [],
        intent: "propose",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-pending",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 7:00.",
              provenance: { actorId: "codex-t3", at },
              validity: { from: at, until: null },
            },
          },
        ],
        relationships: [],
      },
      authority,
    );
    assert.strictEqual(proposed.receipt.outcome, "pending");
    const prepared = yield* prepareTaskMemory(proposed.ledger, request("codex", "attempt-2"));
    assert.deepStrictEqual(prepared.package.orientation.decisions, []);
    assert.strictEqual(prepared.package.orientation.proposals[0]?.factId, "fact-pending");
    assert.strictEqual(prepared.package.orientation.proposals[0]?.actorId, "codex-t3");
    assert.strictEqual(
      orientationText(prepared.package).includes(
        "proposed, not accepted: Saturday games start at 7:00.",
      ),
      true,
    );
    assert.strictEqual(prepared.receipt.memoryVersions.includes("fact-pending"), true);
    assert.strictEqual(prepared.contextPackage.memoryVersions.includes("fact-pending"), true);
    assert.deepStrictEqual(packageFacts(proposed.ledger.graph, "usba", at), []);
  }),
);
