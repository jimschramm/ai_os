import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { applySubmission, initialMemoryLedger, type MemoryLedgerV1 } from "./submission.ts";
import { reviewSteward } from "./steward.ts";
import {
  prepareTaskMemory,
  taskWriteSubmission,
  type AttemptMemoryActivityV1,
} from "./taskMemory.ts";

const at = "2026-10-24T06:00:00Z";
const authority = "jim";
const commit = "c".repeat(40);

const activity = (
  attemptId: string,
  authorId: string,
  write: AttemptMemoryActivityV1["write"],
): AttemptMemoryActivityV1 => ({
  projectId: "usba",
  taskId: "task-page",
  attemptId,
  authorId,
  runtime: "codex",
  read: {
    receiptId: `read-${attemptId}`,
    digest: "a".repeat(32),
    suppliedAt: at,
    memoryVersions: [],
  },
  write,
});

const accept = (ledger: MemoryLedgerV1, id: string, body: string) =>
  applySubmission(
    ledger,
    {
      version: "v1",
      submissionId: `submission-${id}`,
      idempotencyKey: `key-${id}`,
      projectId: "usba",
      authorId: authority,
      taskId: "task-page",
      attemptId: "attempt-seed",
      evidence: [{ evidenceId: `evidence-${id}`, note: "The schedule file says so." }],
      expectedVersions: [],
      intent: "accept",
      facts: [
        {
          identity: "tournament-start",
          fact: {
            acceptance: "proposed",
            factId: `fact-${id}`,
            projectId: "usba",
            kind: "Decision",
            body,
            provenance: { actorId: authority, at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
    },
    authority,
  );

it.effect("flags a missing write and an open conflict for the agent that made them", () =>
  Effect.gen(function* () {
    const first = yield* accept(initialMemoryLedger, "accepted", "Saturday games start at 7:00.");
    const prepared = yield* prepareTaskMemory(first.ledger, {
      projectId: "usba",
      taskId: "task-page",
      attemptId: "attempt-b",
      authorId: "agent-b",
      runtime: "cursor",
      repoCommit: commit,
      requirements: "The tournament page shows the new schedule.",
      authorizationScope: "usba-web",
      createdAt: at,
    });
    const submission = yield* taskWriteSubmission(first.ledger, prepared.receipt, {
      kind: "findings",
      facts: [
        {
          identity: "tournament-start",
          fact: {
            acceptance: "proposed",
            factId: "fact-agent-b",
            projectId: "usba",
            kind: "Decision",
            body: "Saturday games start at 8:30.",
            provenance: { actorId: "agent-b", at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
      evidence: [{ evidenceId: "evidence-b", note: "Agent B read a later note." }],
    });
    const conflicted = yield* applySubmission(first.ledger, submission, authority);
    const notices = reviewSteward(conflicted.ledger, [
      activity("attempt-a", "agent-a", null),
      activity("attempt-b", "agent-b", {
        submissionId: "write-attempt-b",
        outcome: "conflict",
        detail: "The accepted statement was kept. The submission is an open conflict.",
        factIds: ["fact-agent-b"],
      }),
    ]);
    const missing = notices.find((notice) => notice.kind === "missing_write");
    const conflict = notices.find((notice) => notice.kind === "open_conflict");
    assert.strictEqual(missing?.authorId, "agent-a");
    assert.strictEqual(missing?.attemptId, "attempt-a");
    assert.strictEqual(conflict?.authorId, "agent-b");
    assert.strictEqual(conflict?.acceptedFactId, "fact-accepted");
    assert.strictEqual(conflict?.proposedFactId, "fact-agent-b");
    assert.equal(conflict?.summary.includes("conflicts with accepted memory"), true);
    assert.equal(conflict?.summary.includes("Saturday games start at 7:00."), true);
    assert.equal(conflict?.summary.includes("Saturday games start at 8:30."), true);
    assert.strictEqual(
      notices.some((notice) => notice.attemptId === "attempt-b" && notice.kind === "missing_write"),
      false,
    );
  }),
);

it.effect("names a conflict between two proposals as a proposal", () =>
  Effect.gen(function* () {
    const first = yield* applySubmission(
      initialMemoryLedger,
      {
        version: "v1",
        submissionId: "submission-a",
        idempotencyKey: "key-a",
        projectId: "usba",
        authorId: "agent-a",
        taskId: "task-page",
        attemptId: "attempt-a",
        evidence: [{ evidenceId: "evidence-a", note: "Agent A read the schedule." }],
        expectedVersions: [],
        intent: "propose",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-a",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 7:00.",
              provenance: { actorId: "agent-a", at },
              validity: { from: at, until: null },
            },
          },
        ],
        relationships: [],
      },
      authority,
    );
    const second = yield* applySubmission(
      first.ledger,
      {
        version: "v1",
        submissionId: "submission-b",
        idempotencyKey: "key-b",
        projectId: "usba",
        authorId: "agent-b",
        taskId: "task-page",
        attemptId: "attempt-b",
        evidence: [{ evidenceId: "evidence-b", note: "Agent B read a later note." }],
        expectedVersions: [],
        intent: "propose",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-b",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 8:30.",
              provenance: { actorId: "agent-b", at },
              validity: { from: at, until: null },
            },
          },
        ],
        relationships: [],
      },
      authority,
    );
    assert.strictEqual(second.receipt.outcome, "conflict");
    const notices = reviewSteward(second.ledger, []);
    const conflict = notices.find((notice) => notice.kind === "open_conflict");
    assert.equal(conflict?.summary.includes("conflicts with a proposal"), true);
    assert.equal(conflict?.summary.includes("accepted memory"), false);
    assert.strictEqual(notices.filter((notice) => notice.kind === "open_conflict").length, 1);
  }),
);

it.effect("skips a missing write while the attempt is still running", () =>
  Effect.sync(() => {
    const running = activity("attempt-live", "agent-a", null);
    const ended = activity("attempt-done", "agent-a", null);
    const notices = reviewSteward(initialMemoryLedger, [running, ended], new Set(["attempt-live"]));
    assert.strictEqual(
      notices.some((notice) => notice.attemptId === "attempt-live"),
      false,
    );
    assert.strictEqual(
      notices.find((notice) => notice.attemptId === "attempt-done")?.kind,
      "missing_write",
    );
  }),
);
