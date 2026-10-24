import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { packageFacts, packageProposals } from "./memory.ts";
import {
  applySubmission,
  initialMemoryLedger,
  type MemoryLedgerV1,
  type SubmissionV1,
} from "./submission.ts";

const at = "2026-10-24T06:00:00Z";
const authority = "jim";

const proposal = (
  id: string,
  body: string,
  overrides: Partial<SubmissionV1> = {},
): SubmissionV1 => ({
  version: "v1",
  submissionId: `submission-${id}`,
  idempotencyKey: `key-${id}`,
  projectId: "usba",
  authorId: "codex-t3",
  taskId: "task-page",
  attemptId: "attempt-1",
  evidence: [{ evidenceId: `evidence-${id}`, note: "The schedule file says so." }],
  expectedVersions: [],
  intent: "propose",
  facts: [
    {
      identity: "tournament-start",
      fact: {
        acceptance: "proposed",
        factId: `fact-${id}`,
        projectId: "usba",
        kind: "Decision",
        body,
        provenance: { actorId: "codex-t3", at },
        validity: { from: at, until: null },
      },
    },
  ],
  relationships: [],
  ...overrides,
});

const accept = (ledger: MemoryLedgerV1, id: string, body: string, revision: number) =>
  applySubmission(
    ledger,
    proposal(id, body, {
      authorId: authority,
      intent: "accept",
      expectedVersions: revision === 0 ? [] : [{ factId: `fact-accepted`, revision }],
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
    }),
    authority,
  );

it.effect("records a proposal and its relationship together, and not as knowledge", () =>
  Effect.gen(function* () {
    const submitted = proposal("one", "Saturday games start at 7:00.", {
      facts: [
        ...proposal("one", "Saturday games start at 7:00.").facts,
        {
          identity: "schedule-source",
          fact: {
            acceptance: "proposed",
            factId: "fact-source-one",
            projectId: "usba",
            kind: "Source",
            body: "Drive file schedule-v3.",
            provenance: { actorId: "codex-t3", at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [
        {
          acceptance: "proposed",
          relationshipId: "rel-one",
          projectId: "usba",
          relationshipType: "SUPPORTED_BY",
          fromId: "fact-one",
          toId: "fact-source-one",
          provenance: { actorId: "codex-t3", at },
          validity: { from: at, until: null },
        },
      ],
    });
    const result = yield* applySubmission(initialMemoryLedger, submitted, authority);
    assert.strictEqual(result.receipt.outcome, "pending");
    assert.strictEqual(result.receipt.authorId, "codex-t3");
    assert.deepStrictEqual(result.receipt.factIds, ["fact-one", "fact-source-one"]);
    assert.deepStrictEqual(result.receipt.relationshipIds, ["rel-one"]);
    assert.strictEqual(result.ledger.graph.facts.length, 2);
    assert.strictEqual(result.ledger.graph.relationships.length, 1);
    assert.deepStrictEqual(packageFacts(result.ledger.graph, "usba", at), []);
    assert.strictEqual(result.ledger.graph.facts[0]?.provenance.actorId, "codex-t3");
  }),
);

it.effect("keeps an accepted decision when a contradictory submission arrives", () =>
  Effect.gen(function* () {
    const first = yield* accept(
      initialMemoryLedger,
      "accepted",
      "Saturday games start at 7:00.",
      0,
    );
    assert.strictEqual(first.receipt.outcome, "accepted");
    assert.deepStrictEqual(
      packageFacts(first.ledger.graph, "usba", at).map((fact) => fact.body),
      ["Saturday games start at 7:00."],
    );
    const agent = yield* applySubmission(
      first.ledger,
      proposal("agent", "Saturday games start at 8:30.", {
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
      }),
      authority,
    );
    assert.strictEqual(agent.receipt.outcome, "conflict");
    assert.deepStrictEqual(agent.receipt.conflictIds, ["conflict-submission-agent-0"]);
    const conflict = agent.ledger.conflicts[0];
    assert.strictEqual(conflict?.authorId, "codex-t3");
    assert.strictEqual(conflict?.acceptedAuthorId, authority);
    assert.strictEqual(conflict?.acceptedFactId, "fact-accepted");
    assert.strictEqual(conflict?.proposedFactId, "fact-agent");
    assert.strictEqual(conflict?.resolvedBySubmissionId, null);
    assert.deepStrictEqual(
      packageFacts(agent.ledger.graph, "usba", at).map((fact) => fact.body),
      ["Saturday games start at 7:00."],
    );
    assert.strictEqual(
      agent.ledger.graph.facts.find((fact) => fact.factId === "fact-agent")?.acceptance,
      "proposed",
    );

    const retry = yield* applySubmission(
      agent.ledger,
      proposal("agent", "Saturday games start at 9:00."),
      authority,
    );
    assert.strictEqual(retry.receipt.outcome, "duplicate");
    assert.strictEqual(retry.receipt.originalSubmissionId, "submission-agent");
    assert.strictEqual(retry.ledger.receipts.length, agent.ledger.receipts.length);
    assert.strictEqual(
      retry.ledger.graph.facts.find((fact) => fact.factId === "fact-agent")?.body,
      "Saturday games start at 8:30.",
    );
  }),
);

it.effect("accepts a new version from the authority and resolves the open conflict", () =>
  Effect.gen(function* () {
    const first = yield* accept(
      initialMemoryLedger,
      "accepted",
      "Saturday games start at 7:00.",
      0,
    );
    const agent = yield* applySubmission(
      first.ledger,
      proposal("agent", "Saturday games start at 8:30.", {
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
      }),
      authority,
    );
    const corrected = yield* applySubmission(
      agent.ledger,
      proposal("correction", "Saturday games start at 8:30.", {
        authorId: authority,
        intent: "accept",
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-correction",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 8:30.",
              provenance: { actorId: authority, at },
              validity: { from: at, until: null },
            },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(corrected.receipt.outcome, "accepted");
    assert.deepStrictEqual(
      packageFacts(corrected.ledger.graph, "usba", at).map((fact) => fact.factId),
      ["fact-correction"],
    );
    assert.strictEqual(
      corrected.ledger.graph.facts.find((fact) => fact.factId === "fact-accepted")?.acceptance,
      "superseded",
    );
    assert.strictEqual(
      corrected.ledger.conflicts[0]?.resolvedBySubmissionId,
      "submission-correction",
    );
    assert.strictEqual(
      corrected.ledger.graph.facts.find((fact) => fact.factId === "fact-agent")?.acceptance,
      "superseded",
    );
    assert.deepStrictEqual(packageProposals(corrected.ledger.graph, "usba", at), []);
    const stale = yield* applySubmission(
      corrected.ledger,
      proposal("late", "Saturday games start at 6:00.", {
        authorId: authority,
        intent: "accept",
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-late",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 6:00.",
              provenance: { actorId: authority, at },
              validity: { from: at, until: null },
            },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(stale.receipt.outcome, "conflict");
    assert.deepStrictEqual(
      packageFacts(stale.ledger.graph, "usba", at).map((fact) => fact.body),
      ["Saturday games start at 8:30."],
    );
  }),
);

it.effect("keeps the accepted statement when the authority resolves the conflict that way", () =>
  Effect.gen(function* () {
    const first = yield* accept(
      initialMemoryLedger,
      "accepted",
      "Saturday games start at 7:00.",
      0,
    );
    const agent = yield* applySubmission(
      first.ledger,
      proposal("agent", "Saturday games start at 8:30.", {
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
      }),
      authority,
    );
    const kept = yield* applySubmission(
      agent.ledger,
      proposal("keep", "Saturday games start at 7:00.", {
        authorId: authority,
        intent: "accept",
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-keep",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 7:00.",
              provenance: { actorId: authority, at },
              validity: { from: at, until: null },
            },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(kept.receipt.outcome, "accepted");
    assert.strictEqual(kept.receipt.detail, "Kept the accepted statement.");
    assert.deepStrictEqual(kept.receipt.factIds, ["fact-accepted"]);
    assert.strictEqual(kept.ledger.conflicts[0]?.resolvedBySubmissionId, "submission-keep");
    assert.strictEqual(
      kept.ledger.graph.facts.find((fact) => fact.factId === "fact-agent")?.acceptance,
      "superseded",
    );
    assert.deepStrictEqual(packageProposals(kept.ledger.graph, "usba", at), []);
    assert.strictEqual(
      kept.ledger.graph.facts.find((fact) => fact.factId === "fact-keep"),
      undefined,
    );
    assert.deepStrictEqual(
      packageFacts(kept.ledger.graph, "usba", at).map((fact) => fact.factId),
      ["fact-accepted"],
    );
    const repeat = yield* applySubmission(
      first.ledger,
      proposal("again", "Saturday games start at 7:00.", {
        authorId: authority,
        intent: "accept",
        expectedVersions: [{ factId: "fact-accepted", revision: 1 }],
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-again",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 7:00.",
              provenance: { actorId: authority, at },
              validity: { from: at, until: null },
            },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(repeat.receipt.outcome, "rejected");
    assert.strictEqual(repeat.receipt.detail, "That statement is already accepted.");
    assert.strictEqual(repeat.ledger.receipts.length, first.ledger.receipts.length);
  }),
);

it.effect("supersedes both proposals when the authority resolves their conflict", () =>
  Effect.gen(function* () {
    const left = yield* applySubmission(
      initialMemoryLedger,
      proposal("left", "Saturday games start at 7:00.", { attemptId: "attempt-left" }),
      authority,
    );
    const right = yield* applySubmission(
      left.ledger,
      proposal("right", "Saturday games start at 8:30.", {
        attemptId: "attempt-right",
        authorId: "agent-b",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-right",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 8:30.",
              provenance: { actorId: "agent-b", at },
              validity: { from: at, until: null },
            },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(right.receipt.outcome, "conflict");
    const resolved = yield* applySubmission(
      right.ledger,
      proposal("resolved", "Saturday games start at 7:30.", {
        authorId: authority,
        intent: "accept",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-resolved",
              projectId: "usba",
              kind: "Decision",
              body: "Saturday games start at 7:30.",
              provenance: { actorId: authority, at },
              validity: { from: at, until: null },
            },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(resolved.receipt.outcome, "accepted");
    assert.strictEqual(
      resolved.ledger.graph.facts.find((fact) => fact.factId === "fact-left")?.acceptance,
      "superseded",
    );
    assert.strictEqual(
      resolved.ledger.graph.facts.find((fact) => fact.factId === "fact-right")?.acceptance,
      "superseded",
    );
    assert.deepStrictEqual(
      packageFacts(resolved.ledger.graph, "usba", at).map((fact) => fact.factId),
      ["fact-resolved"],
    );
    assert.deepStrictEqual(packageProposals(resolved.ledger.graph, "usba", at), []);
  }),
);

it.effect("rejects an agent acceptance, a broken relationship, and an unknown version", () =>
  Effect.gen(function* () {
    const agentAccept = yield* applySubmission(
      initialMemoryLedger,
      proposal("agent-accept", "Saturday games start at 7:00.", { intent: "accept" }),
      authority,
    );
    assert.strictEqual(agentAccept.receipt.outcome, "rejected");
    assert.strictEqual(agentAccept.ledger.receipts.length, 0);
    assert.strictEqual(agentAccept.ledger.graph.facts.length, 0);

    const dangling = yield* applySubmission(
      initialMemoryLedger,
      proposal("dangling", "Saturday games start at 7:00.", {
        relationships: [
          {
            acceptance: "proposed",
            relationshipId: "rel-dangling",
            projectId: "usba",
            relationshipType: "SUPPORTED_BY",
            fromId: "fact-dangling",
            toId: "fact-missing",
            provenance: { actorId: "codex-t3", at },
            validity: { from: at, until: null },
          },
        ],
      }),
      authority,
    );
    assert.strictEqual(dangling.receipt.outcome, "rejected");
    assert.strictEqual(dangling.ledger.graph.relationships.length, 0);

    const malformed = yield* Effect.exit(
      applySubmission(
        initialMemoryLedger,
        { ...proposal("bad", "Saturday games start at 7:00."), extra: true },
        authority,
      ),
    );
    assert.strictEqual(Exit.isFailure(malformed), true);
  }),
);
