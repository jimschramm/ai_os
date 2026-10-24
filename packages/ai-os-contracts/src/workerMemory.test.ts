import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { exampleRepoCommit } from "./examples.ts";
import { historyFacts, packageFacts } from "./memory.ts";
import { applySubmission, initialMemoryLedger, type MemoryLedgerV1 } from "./submission.ts";
import { prepareTaskMemory } from "./taskMemory.ts";
import {
  acceptProposedFact,
  decodeWorkerContextPackageV1,
  policyAcceptsFact,
  workerContextPackage,
  type ProjectMemoryPolicyV1,
} from "./workerMemory.ts";

const at = "2026-10-24T06:00:00Z";
const later = "2026-10-24T18:00:00Z";
const authority = "jim";

const readFor = (projectId: string) => ({
  schemaVersion: "v1" as const,
  projectId,
  repoCommit: exampleRepoCommit,
  requirements: "What does this project already know?",
  authorizationScope: `project:${projectId}`,
  asOf: later,
});

const acceptFact = (
  ledger: MemoryLedgerV1,
  input: {
    readonly projectId: string;
    readonly identity: string;
    readonly factId: string;
    readonly kind: "Instruction" | "Decision";
    readonly body: string;
    readonly authorId?: string;
    readonly expected?: ReadonlyArray<{ factId: string; revision: number }>;
  },
) =>
  applySubmission(
    ledger,
    {
      version: "v1",
      submissionId: `submission-${input.factId}`,
      idempotencyKey: `key-${input.factId}`,
      projectId: input.projectId,
      authorId: input.authorId ?? authority,
      taskId: "task-seed",
      attemptId: `attempt-${input.factId}`,
      evidence: [{ evidenceId: `evidence-${input.factId}`, note: "Recorded from the source." }],
      expectedVersions: input.expected ?? [],
      intent: "accept",
      facts: [
        {
          identity: input.identity,
          fact: {
            acceptance: "proposed",
            factId: input.factId,
            projectId: input.projectId,
            kind: input.kind,
            body: input.body,
            provenance: { actorId: input.authorId ?? authority, at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
    },
    authority,
  );

const proposeFact = (
  ledger: MemoryLedgerV1,
  input: {
    readonly projectId: string;
    readonly identity: string;
    readonly factId: string;
    readonly body: string;
    readonly authorId: string;
    readonly kind?: "Instruction" | "Decision";
  },
) =>
  applySubmission(
    ledger,
    {
      version: "v1",
      submissionId: `submission-${input.factId}`,
      idempotencyKey: `key-${input.factId}`,
      projectId: input.projectId,
      authorId: input.authorId,
      taskId: "task-seed",
      attemptId: `attempt-${input.factId}`,
      evidence: [{ evidenceId: `evidence-${input.factId}`, note: "The worker proposed it." }],
      expectedVersions: [],
      intent: "propose",
      facts: [
        {
          identity: input.identity,
          fact: {
            acceptance: "proposed",
            factId: input.factId,
            projectId: input.projectId,
            kind: input.kind ?? "Instruction",
            body: input.body,
            provenance: { actorId: input.authorId, at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
    },
    authority,
  );

it.effect("packages one project's accepted current facts and leaves proposals out", () =>
  Effect.gen(function* () {
    const wow = yield* acceptFact(initialMemoryLedger, {
      projectId: "wow-harness",
      identity: "raid-night",
      factId: "fact-raid",
      kind: "Instruction",
      body: "Raid night is Thursday.",
    });
    const other = yield* acceptFact(wow.ledger, {
      projectId: "usba",
      identity: "start",
      factId: "fact-start",
      kind: "Decision",
      body: "Saturday games start at 7:00.",
    });
    const proposed = yield* proposeFact(other.ledger, {
      projectId: "wow-harness",
      identity: "addons",
      factId: "fact-addons",
      body: "Track addon versions.",
      authorId: "wow-harness",
    });
    const packaged = yield* workerContextPackage(
      proposed.ledger,
      readFor("wow-harness"),
      "wow-harness",
    );
    assert.deepStrictEqual(
      packaged.facts.map((fact) => fact.factId),
      ["fact-raid"],
    );
    assert.deepStrictEqual(packaged.contextPackage.memoryVersions, ["fact-raid"]);
    assert.strictEqual(packaged.runtime, "local-worker");
    assert.strictEqual("candidates" in packaged, false);
    assert.strictEqual(
      packaged.facts.some(
        (fact) => fact.projectId !== "wow-harness" || fact.acceptance !== "accepted",
      ),
      false,
    );
    const withCandidates = yield* Effect.exit(
      decodeWorkerContextPackageV1({ ...packaged, candidates: [] }),
    );
    assert.strictEqual(Exit.isFailure(withCandidates), true);
  }),
);

it.effect("keeps a superseded fact out of the package and still in history", () =>
  Effect.gen(function* () {
    const first = yield* acceptFact(initialMemoryLedger, {
      projectId: "wow-harness",
      identity: "raid-night",
      factId: "fact-thursday",
      kind: "Decision",
      body: "Raid night is Thursday.",
    });
    const replaced = yield* acceptFact(first.ledger, {
      projectId: "wow-harness",
      identity: "raid-night",
      factId: "fact-friday",
      kind: "Decision",
      body: "Raid night is Friday.",
      expected: [{ factId: "fact-thursday", revision: 1 }],
    });
    assert.strictEqual(replaced.receipt.outcome, "accepted");
    const packaged = yield* workerContextPackage(
      replaced.ledger,
      readFor("wow-harness"),
      "wow-harness",
    );
    assert.deepStrictEqual(
      packaged.facts.map((fact) => fact.body),
      ["Raid night is Friday."],
    );
    const history = historyFacts(replaced.ledger.graph, "wow-harness");
    const older = history.find((fact) => fact.factId === "fact-thursday");
    assert.strictEqual(older?.acceptance, "superseded");
    assert.strictEqual(
      packageFacts(replaced.ledger.graph, "wow-harness", later).some(
        (fact) => fact.factId === "fact-thursday",
      ),
      false,
    );
  }),
);

it.effect("accepts a proposal in place and refuses one that conflicts", () =>
  Effect.gen(function* () {
    const proposed = yield* proposeFact(initialMemoryLedger, {
      projectId: "wow-harness",
      identity: "addons",
      factId: "fact-addons",
      body: "Track addon versions.",
      authorId: "wow-harness",
    });
    const before = yield* workerContextPackage(
      proposed.ledger,
      readFor("wow-harness"),
      "wow-harness",
    );
    assert.deepStrictEqual(before.facts, []);
    const accepted = yield* acceptProposedFact(proposed.ledger, {
      factId: "fact-addons",
      projectId: "wow-harness",
      acceptedBy: authority,
      acceptedAt: later,
    });
    const fact = accepted.graph.facts.find((item) => item.factId === "fact-addons");
    assert.strictEqual(fact?.acceptance, "accepted");
    if (fact?.acceptance === "accepted") {
      assert.strictEqual(fact.provenance.actorId, "wow-harness");
      assert.strictEqual(fact.acceptedBy, authority);
    }
    const after = yield* workerContextPackage(accepted, readFor("wow-harness"), "wow-harness");
    assert.deepStrictEqual(
      after.facts.map((item) => item.factId),
      ["fact-addons"],
    );

    const current = yield* acceptFact(initialMemoryLedger, {
      projectId: "wow-harness",
      identity: "raid-night",
      factId: "fact-thursday",
      kind: "Decision",
      body: "Raid night is Thursday.",
    });
    const conflict = yield* proposeFact(current.ledger, {
      projectId: "wow-harness",
      identity: "raid-night",
      factId: "fact-friday",
      kind: "Decision",
      body: "Raid night is Friday.",
      authorId: "wow-harness",
    });
    const refused = yield* Effect.flip(
      acceptProposedFact(conflict.ledger, {
        factId: "fact-friday",
        projectId: "wow-harness",
        acceptedBy: authority,
        acceptedAt: later,
      }),
    );
    assert.strictEqual(
      refused.detail,
      "That proposal conflicts with accepted knowledge. The steward resolves it.",
    );
    assert.strictEqual(
      conflict.ledger.graph.facts.find((item) => item.factId === "fact-thursday")?.acceptance,
      "accepted",
    );
  }),
);

it.effect("matches an auto-accept policy only when the owner enabled that fact", () =>
  Effect.gen(function* () {
    const instruction = {
      projectId: "wow-harness",
      kind: "Instruction" as const,
      provenance: { actorId: "jim" },
    };
    assert.strictEqual(policyAcceptsFact(null, instruction), false);
    const disabled: ProjectMemoryPolicyV1 = {
      schemaVersion: "v1",
      projectId: "wow-harness",
      enabled: false,
      rules: [{ kinds: ["Instruction"], actorIds: ["jim"] }],
    };
    assert.strictEqual(policyAcceptsFact(disabled, instruction), false);
    const userInstructions: ProjectMemoryPolicyV1 = {
      schemaVersion: "v1",
      projectId: "wow-harness",
      enabled: true,
      rules: [{ kinds: ["Instruction"], actorIds: ["jim"] }],
    };
    assert.strictEqual(policyAcceptsFact(userInstructions, instruction), true);
    assert.strictEqual(
      policyAcceptsFact(userInstructions, { ...instruction, kind: "Decision" }),
      false,
    );
    assert.strictEqual(
      policyAcceptsFact(userInstructions, {
        ...instruction,
        provenance: { actorId: "wow-harness" },
      }),
      false,
    );
    assert.strictEqual(
      policyAcceptsFact(userInstructions, { ...instruction, projectId: "usba" }),
      false,
    );
    const anyInstruction: ProjectMemoryPolicyV1 = {
      schemaVersion: "v1",
      projectId: "wow-harness",
      enabled: true,
      rules: [{ kinds: ["Instruction"], anyActor: true }],
    };
    assert.strictEqual(
      policyAcceptsFact(anyInstruction, {
        ...instruction,
        provenance: { actorId: "wow-harness" },
      }),
      true,
    );
    const prepared = yield* prepareTaskMemory(initialMemoryLedger, {
      projectId: "wow-harness",
      taskId: "task-wow",
      attemptId: "attempt-wow",
      authorId: "wow-harness",
      runtime: "local-worker",
      repoCommit: exampleRepoCommit,
      requirements: "Read the project.",
      authorizationScope: "project:wow-harness",
      createdAt: at,
    });
    assert.strictEqual(prepared.receipt.runtime, "local-worker");
  }),
);
