import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeContextPackageSnapshotV1 } from "./assignment.ts";
import { exampleRepoCommit } from "./examples.ts";
import {
  applyMemoryEvent,
  buildRetrieval,
  decodeMemoryEvent,
  decodeRetrievalResponseV1,
  historyFacts,
  initialMemoryGraph,
  packageFacts,
} from "./memory.ts";

const at = "2026-10-21T15:00:00Z";
const later = "2026-10-21T18:00:00Z";
const nodeKinds = [
  "Project",
  "Repository",
  "Environment",
  "Requirement",
  "Instruction",
  "Decision",
  "Task",
  "Attempt",
  "Handoff",
  "Artifact",
  "Source",
  "Verification",
  "Agent",
  "User",
  "Procedure",
] as const;
const relationshipTypes = [
  "BELONGS_TO",
  "DEPLOYED_IN",
  "APPLIES_TO",
  "CONSTRAINS",
  "SUPERSEDES",
  "DEPENDS_ON",
  "IMPLEMENTS",
  "CONTINUES",
  "PRODUCED_BY",
  "SUPPORTED_BY",
  "VERIFIED_BY",
  "ASSIGNED_TO",
  "ACCEPTED_BY",
  "USES",
] as const;

const fact = (factId: string, acceptance: "proposed" | "accepted" = "proposed") => ({
  acceptance,
  factId,
  projectId: "usba",
  kind: "Decision" as const,
  body: `Fact ${factId}.`,
  provenance: { actorId: "jim", at },
  validity: { from: at, until: later },
  ...(acceptance === "accepted" ? { acceptedBy: "jim", acceptedAt: at } : {}),
});

const request = {
  version: "v1" as const,
  taskId: "task-usba-page",
  projectId: "usba",
  asOf: at,
  question: "What does the tournament page need to show?",
  requirements: "The tournament page shows the new schedule.",
  repoCommit: exampleRepoCommit,
  authorizationScope: "usba-web",
};

const failure = (graph: unknown, event: unknown) => Effect.flip(applyMemoryEvent(graph, event));

it.effect("accepts only documented node kinds and relationship types", () =>
  Effect.gen(function* () {
    for (const kind of nodeKinds) {
      const decoded = yield* decodeMemoryEvent({
        type: "propose_fact",
        fact: { ...fact(`fact-${kind}`), kind },
      });
      assert.strictEqual(decoded.type, "propose_fact");
    }
    for (const relationshipType of relationshipTypes) {
      const decoded = yield* decodeMemoryEvent({
        type: "supersede",
        relationship: {
          acceptance: "accepted",
          relationshipId: `rel-${relationshipType}`,
          projectId: "usba",
          relationshipType,
          fromId: "decision-new",
          toId: "decision-old",
          provenance: { actorId: "jim", at },
          validity: { from: at, until: null },
          acceptedBy: "jim",
          acceptedAt: at,
        },
      });
      assert.strictEqual(decoded.type, "supersede");
    }
    const note = yield* Effect.exit(
      decodeMemoryEvent({ type: "propose_fact", fact: { ...fact("fact-note"), kind: "Note" } }),
    );
    const related = yield* Effect.exit(
      decodeMemoryEvent({
        type: "supersede",
        relationship: {
          acceptance: "accepted",
          relationshipId: "rel-related",
          projectId: "usba",
          relationshipType: "RELATED_TO",
          fromId: "decision-new",
          toId: "decision-old",
          provenance: { actorId: "jim", at },
          validity: { from: at, until: null },
          acceptedBy: "jim",
          acceptedAt: at,
        },
      }),
    );
    const missingProvenance = yield* Effect.exit(
      decodeMemoryEvent({
        type: "propose_fact",
        fact: {
          acceptance: "proposed",
          factId: "decision-bare",
          projectId: "usba",
          kind: "Decision",
          body: "No provenance.",
          validity: { from: at, until: null },
        },
      }),
    );
    assert.strictEqual(Exit.isFailure(note), true);
    assert.strictEqual(Exit.isFailure(related), true);
    assert.strictEqual(Exit.isFailure(missingProvenance), true);
  }),
);

it.effect("builds a context package only from accepted current facts", () =>
  Effect.gen(function* () {
    const source = fact("decision-old");
    let graph = yield* applyMemoryEvent(initialMemoryGraph, { type: "propose_fact", fact: source });
    source.body = "changed by caller";
    const stored = graph.facts[0];
    if (stored === undefined) {
      return yield* Effect.die("The proposed fact must be stored.");
    }
    assert.strictEqual(stored.body, "Fact decision-old.");
    assert.throws(() => {
      (stored as { body: string }).body = "stored mutation";
    });

    const proposedOnly = yield* buildRetrieval(graph, request, []);
    assert.deepStrictEqual(proposedOnly.contextPackage.memoryVersions, []);

    graph = yield* applyMemoryEvent(graph, {
      type: "accept_fact",
      factId: "decision-old",
      acceptedBy: "jim",
      acceptedAt: at,
    });
    graph = yield* applyMemoryEvent(graph, {
      type: "propose_fact",
      fact: fact("decision-new"),
    });
    graph = yield* applyMemoryEvent(graph, {
      type: "accept_fact",
      factId: "decision-new",
      acceptedBy: "qa",
      acceptedAt: at,
    });
    graph = yield* applyMemoryEvent(graph, {
      type: "supersede",
      relationship: {
        acceptance: "accepted",
        relationshipId: "rel-supersede",
        projectId: "usba",
        relationshipType: "SUPERSEDES",
        fromId: "decision-new",
        toId: "decision-old",
        provenance: { actorId: "qa", at },
        validity: { from: at, until: null },
        acceptedBy: "qa",
        acceptedAt: at,
      },
    });

    const packaged = packageFacts(graph, "usba", at).map((item) => item.factId);
    const history = historyFacts(graph, "usba").map((item) => item.factId);
    assert.deepStrictEqual(packaged, ["decision-new"]);
    assert.deepStrictEqual(history, ["decision-old", "decision-new"]);
    assert.strictEqual(graph.facts.length, 2);
    assert.strictEqual(graph.relationships.length, 1);

    const expired = yield* buildRetrieval(graph, { ...request, asOf: later }, []);
    assert.deepStrictEqual(expired.contextPackage.memoryVersions, []);

    const candidates = [
      { nodeId: "not-a-fact", score: 0.9, source: "chroma" as const },
      { nodeId: "decision-new", score: 0.8, source: "chroma" as const },
    ];
    const current = yield* buildRetrieval(graph, request, candidates);
    const withoutCandidates = yield* buildRetrieval(graph, request, []);
    assert.deepStrictEqual(current.contextPackage, withoutCandidates.contextPackage);
    assert.deepStrictEqual(current.contextPackage.memoryVersions, ["decision-new"]);
    assert.deepStrictEqual(
      current.candidates.map((candidate) => candidate.nodeId),
      ["not-a-fact", "decision-new"],
    );
    assert.strictEqual(Object.isFrozen(current.contextPackage), true);
    assert.throws(() => {
      (current.candidates as Array<unknown>).push({ nodeId: "extra", score: 1, source: "chroma" });
    });
  }),
);

it.effect("rejects vector candidates inside a context package and ineligible memory events", () =>
  Effect.gen(function* () {
    const overlapped = yield* decodeRetrievalResponseV1({
      version: "v1",
      contextPackage: {
        requirements: "The tournament page shows the new schedule.",
        memoryVersions: ["decision-new"],
        repoCommit: exampleRepoCommit,
        authorizationScope: "usba-web",
        createdAt: at,
      },
      candidates: [{ nodeId: "decision-new", score: 0.4, source: "chroma" }],
    });
    assert.deepStrictEqual(overlapped.contextPackage.memoryVersions, ["decision-new"]);
    const packagedCandidates = yield* Effect.exit(
      decodeContextPackageSnapshotV1({
        requirements: "The tournament page shows the new schedule.",
        memoryVersions: ["decision-new"],
        repoCommit: exampleRepoCommit,
        authorizationScope: "usba-web",
        createdAt: at,
        candidates: [{ nodeId: "decision-new", score: 0.4, source: "chroma" }],
      }),
    );
    const earlyAccept = yield* failure(initialMemoryGraph, {
      type: "accept_fact",
      factId: "missing",
      acceptedBy: "jim",
      acceptedAt: at,
    });
    const proposed = yield* applyMemoryEvent(initialMemoryGraph, {
      type: "propose_fact",
      fact: fact("decision-old"),
    });
    const supersedeProposed = yield* failure(proposed, {
      type: "supersede",
      relationship: {
        acceptance: "accepted",
        relationshipId: "rel-early",
        projectId: "usba",
        relationshipType: "SUPERSEDES",
        fromId: "decision-new",
        toId: "decision-old",
        provenance: { actorId: "jim", at },
        validity: { from: at, until: null },
        acceptedBy: "jim",
        acceptedAt: at,
      },
    });
    const invalid = yield* failure(initialMemoryGraph, {
      type: "propose_fact",
      fact: { ...fact("decision-blank"), body: "   " },
    });
    const badGraph = yield* failure({ facts: [] }, { type: "accept_fact", factId: "x" });
    const shortCommit = yield* Effect.flip(
      buildRetrieval(initialMemoryGraph, { ...request, repoCommit: "abc1234" }, []),
    );
    assert.strictEqual(Exit.isFailure(packagedCandidates), true);
    assert.strictEqual(earlyAccept.reason, "memory_not_eligible");
    assert.strictEqual(supersedeProposed.reason, "memory_not_eligible");
    assert.strictEqual(invalid.reason, "invalid_payload");
    assert.strictEqual(invalid.event, "propose_fact");
    assert.strictEqual(badGraph.reason, "invalid_payload");
    assert.strictEqual(shortCommit.reason, "invalid_payload");
  }),
);

it.effect("derives package membership from same-project SUPERSEDES edges", () =>
  Effect.gen(function* () {
    const accepted = (factId: string, projectId = "usba") => ({
      acceptance: "accepted" as const,
      factId,
      projectId,
      kind: "Decision" as const,
      body: `Fact ${factId}.`,
      provenance: { actorId: "jim", at },
      validity: { from: at, until: null as string | null },
      acceptedBy: "jim",
      acceptedAt: at,
    });
    const supersedes = (fromId: string, toId: string, projectId = "usba") => ({
      acceptance: "accepted" as const,
      relationshipId: `rel-${fromId}-${toId}`,
      projectId,
      relationshipType: "SUPERSEDES" as const,
      fromId,
      toId,
      provenance: { actorId: "jim", at },
      validity: { from: at, until: null },
      acceptedBy: "jim",
      acceptedAt: at,
    });
    const stillAccepted = yield* buildRetrieval(
      {
        facts: [accepted("decision-old"), accepted("decision-new")],
        relationships: [supersedes("decision-new", "decision-old")],
      },
      request,
      [],
    );
    assert.deepStrictEqual(stillAccepted.contextPackage.memoryVersions, ["decision-new"]);

    const statusOnly = yield* buildRetrieval(
      {
        facts: [
          {
            ...accepted("decision-old"),
            acceptance: "superseded" as const,
            supersededBy: "decision-new",
          },
        ],
        relationships: [],
      },
      request,
      [],
    );
    assert.deepStrictEqual(statusOnly.contextPackage.memoryVersions, ["decision-old"]);

    const crossProject = {
      facts: [accepted("decision-new"), accepted("decision-old", "other")],
      relationships: [supersedes("decision-new", "decision-old")],
    };
    const otherPackage = yield* buildRetrieval(
      crossProject,
      { ...request, projectId: "other" },
      [],
    );
    assert.deepStrictEqual(otherPackage.contextPackage.memoryVersions, ["decision-old"]);

    let graph = yield* applyMemoryEvent(initialMemoryGraph, {
      type: "propose_fact",
      fact: fact("decision-home"),
    });
    graph = yield* applyMemoryEvent(graph, {
      type: "accept_fact",
      factId: "decision-home",
      acceptedBy: "jim",
      acceptedAt: at,
    });
    graph = yield* applyMemoryEvent(graph, {
      type: "propose_fact",
      fact: { ...fact("decision-away"), projectId: "other" },
    });
    graph = yield* applyMemoryEvent(graph, {
      type: "accept_fact",
      factId: "decision-away",
      acceptedBy: "jim",
      acceptedAt: at,
    });
    const crossed = yield* failure(graph, {
      type: "supersede",
      relationship: supersedes("decision-home", "decision-away"),
    });
    assert.strictEqual(crossed.reason, "memory_not_eligible");

    const fractional = yield* buildRetrieval(
      {
        facts: [
          {
            ...accepted("decision-fraction"),
            validity: {
              from: "2026-10-21T15:00:00Z",
              until: "2026-10-21T15:00:00.5Z",
            },
          },
        ],
        relationships: [],
      },
      { ...request, asOf: "2026-10-21T15:00:00.4Z" },
      [],
    );
    const equalInstant = yield* buildRetrieval(
      {
        facts: [
          {
            ...accepted("decision-equal"),
            validity: { from: "2026-10-21T15:00:00.1Z", until: null },
          },
        ],
        relationships: [],
      },
      { ...request, asOf: "2026-10-21T15:00:00.100Z" },
      [],
    );
    assert.deepStrictEqual(fractional.contextPackage.memoryVersions, ["decision-fraction"]);
    assert.deepStrictEqual(equalInstant.contextPackage.memoryVersions, ["decision-equal"]);
  }),
);
