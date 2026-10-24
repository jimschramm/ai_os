import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeMemoryGraphV1, packageFacts } from "@t3tools/ai-os-contracts";

import { OPERATIONS_TASKS } from "./fixtures";
import { ATTEMPT_ACTIVITY, MEMORY_GRAPH } from "./memoryFixtures";
import {
  INITIAL_MEMORY_REVIEW,
  attemptActivityFor,
  boardAttemptActivity,
  conflictingIds,
  contextPackageView,
  cortexRing,
  currentFacts,
  displayStatus,
  drawerProjectId,
  filterRows,
  layoutCortex,
  memoryRows,
  rowsFromFacts,
  stewardConflicts,
  stewardNeedsYou,
  boardStewardNotices,
  boardMemoryFacts,
  versionChain,
} from "./memoryModel";

describe("operations memory", () => {
  it.effect("decodes the fixture graph", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeMemoryGraphV1(structuredClone(MEMORY_GRAPH));
      expect(decoded.facts.length).toBe(MEMORY_GRAPH.facts.length);
    }),
  );

  it("packages the current Saturday time and leaves the old one in history", () => {
    const current = packageFacts(MEMORY_GRAPH, "usba", "2026-10-21T17:00:00Z");
    expect(current.some((fact) => fact.factId === "fact-saturday-start")).toBe(true);
    expect(current.some((fact) => fact.factId === "fact-saturday-830")).toBe(false);
    expect(versionChain("fact-saturday-830").map((fact) => fact.factId)).toEqual([
      "fact-saturday-start",
      "fact-saturday-830",
    ]);
    expect(currentFacts("usba").some((fact) => fact.factId === "fact-saturday-830")).toBe(false);
  });

  it("keeps the Friday claims in conflict without a supersession edge", () => {
    const ids = conflictingIds("usba", INITIAL_MEMORY_REVIEW);
    expect([...ids].sort()).toEqual(["fact-friday-6", "fact-friday-7"]);
    expect(
      MEMORY_GRAPH.relationships.some(
        (relationship) =>
          relationship.relationshipType === "SUPERSEDES" &&
          (relationship.fromId === "fact-friday-7" || relationship.fromId === "fact-friday-6"),
      ),
    ).toBe(false);
    const friday = MEMORY_GRAPH.facts.find((fact) => fact.factId === "fact-friday-7");
    expect(friday).toBeDefined();
    expect(displayStatus(friday!, INITIAL_MEMORY_REVIEW, ids)).toBe("conflicting");
  });

  it("shows a persisted attempt in the drawer data for the agent that wrote it", () => {
    const attempt = ATTEMPT_ACTIVITY[0];
    if (attempt === undefined) throw new Error("expected a sample attempt");
    const activity = boardAttemptActivity([{ attempts: [attempt] }, { attempts: [attempt] }]);
    const rows = attemptActivityFor(activity, "usba", "saturday-copy");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorId).toBe("codex-t3");
    expect(rows[0]?.runtime).toBe("codex");
    expect(rows[0]?.read.receiptId).toBe(attempt.read.receiptId);
    expect(rows[0]?.write?.outcome).toBe("pending");
    expect(boardAttemptActivity([{ attempts: [{ not: "an attempt" }] }])).toEqual([]);
  });

  it("attributes an attempt's read and write to the agent that made them", () => {
    const rows = attemptActivityFor(ATTEMPT_ACTIVITY, "usba", "saturday-copy");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorId).toBe("codex-t3");
    expect(rows[0]?.read.memoryVersions).toEqual(["fact-governing-copy", "fact-saturday-start"]);
    expect(rows[0]?.write?.outcome).toBe("pending");
    expect(attemptActivityFor(ATTEMPT_ACTIVITY, "personal", null)).toEqual([]);
    expect(attemptActivityFor(ATTEMPT_ACTIVITY, "usba", "other-task")).toEqual([]);
  });

  it("filters scope, type, and the seeded rejection", () => {
    const rows = memoryRows("usba", INITIAL_MEMORY_REVIEW);
    const preferences = filterRows(rows, {
      query: "",
      scope: "all",
      type: "preferences",
      status: "all",
      currentTaskId: null,
    });
    expect(preferences.every((row) => row.fact.kind === "User")).toBe(true);
    const rejected = filterRows(rows, {
      query: "banner",
      scope: "project",
      type: "preferences",
      status: "rejected",
      currentTaskId: null,
    });
    expect(rejected.map((row) => row.fact.factId)).toEqual(["fact-banner-proposed"]);
    const taskRows = filterRows(rows, {
      query: "",
      scope: "task",
      type: "all",
      status: "all",
      currentTaskId: "saturday-copy",
    });
    expect(taskRows.every((row) => row.meta.taskId === "saturday-copy")).toBe(true);
  });

  it("gives the schedule task an immutable package and keeps suggestions out", () => {
    const task = OPERATIONS_TASKS.find((item) => item.id === "saturday-copy");
    expect(task).toBeDefined();
    const view = contextPackageView(task!);
    expect(view?.versionIds).toEqual(["fact-governing-copy", "fact-saturday-start", "fact-gym"]);
    expect(view?.records.map((fact) => fact.kind)).toEqual([
      "Instruction",
      "Decision",
      "Requirement",
    ]);
    for (const candidate of task!.candidates) {
      expect(view?.versionIds.includes(candidate.nodeId)).toBe(false);
    }
    expect(cortexRing("Instruction")).toBe("inner");
    expect(cortexRing("Procedure")).toBe("mid");
    expect(cortexRing("Task")).toBe("outer");
  });

  it("draws supersession from the new Saturday time toward the old one", () => {
    const layout = layoutCortex("usba", INITIAL_MEMORY_REVIEW, {
      scope: "all",
      status: "all",
      currentTaskId: null,
    });
    expect(layout.conflictCount).toBe(1);
    expect(
      layout.nodes
        .filter((node) => node.conflicting)
        .map((node) => node.fact.factId)
        .sort(),
    ).toEqual(["fact-friday-6", "fact-friday-7"]);
    const oldNode = layout.nodes.find((node) => node.fact.factId === "fact-saturday-830");
    expect(oldNode?.dimmed).toBe(true);
    expect(layout.arcs).toEqual([
      expect.objectContaining({ fromId: "fact-saturday-start", toId: "fact-saturday-830" }),
    ]);
    const inner = layout.nodes.find((node) => node.ring === "inner");
    const mid = layout.nodes.find((node) => node.ring === "mid");
    expect(inner).toBeDefined();
    expect(mid).toBeDefined();
    expect(Math.hypot(mid!.x - 360, mid!.y - 360)).toBeGreaterThan(
      Math.hypot(inner!.x - 360, inner!.y - 360),
    );
  });

  it("shows a steward conflict in the drawer, tagged with the agent, and a missing write in Needs you", () => {
    const accepted = {
      acceptance: "accepted" as const,
      factId: "fact-accepted",
      projectId: "usba",
      kind: "Decision" as const,
      body: "Saturday games start at 7:00.",
      provenance: { actorId: "agent-a", at: "2026-10-24T06:00:00Z" },
      validity: { from: "2026-10-24T06:00:00Z", until: null },
      acceptedBy: "jim",
      acceptedAt: "2026-10-24T06:00:00Z",
    };
    const proposed = {
      acceptance: "proposed" as const,
      factId: "fact-proposed",
      projectId: "usba",
      kind: "Decision" as const,
      body: "Saturday games start at 8:30.",
      provenance: { actorId: "agent-b", at: "2026-10-24T06:00:00Z" },
      validity: { from: "2026-10-24T06:00:00Z", until: null },
    };
    const notices = [
      {
        noticeId: "steward-conflict-conflict-1",
        projectId: "usba",
        taskId: "saturday-copy",
        kind: "open_conflict" as const,
        authorId: "agent-b",
        summary:
          "agent-b conflicts with accepted memory: Saturday games start at 7:00. / Saturday games start at 8:30.",
        conflictId: "conflict-1",
        attemptId: "attempt-b",
        acceptedFactId: "fact-accepted",
        proposedFactId: "fact-proposed",
      },
      {
        noticeId: "steward-write-attempt-a",
        projectId: "usba",
        taskId: "saturday-copy",
        kind: "missing_write" as const,
        authorId: "agent-a",
        summary: "agent-a read memory on attempt-a and did not write findings.",
        conflictId: null,
        attemptId: "attempt-a",
        acceptedFactId: null,
        proposedFactId: null,
      },
    ];
    const decoded = boardStewardNotices([{ steward: notices }, { steward: notices }]);
    expect(decoded.map((notice) => notice.noticeId)).toEqual([
      "steward-conflict-conflict-1",
      "steward-write-attempt-a",
    ]);
    const conflicts = stewardConflicts(decoded, [accepted, proposed], "usba");
    expect(conflicts).toEqual([
      expect.objectContaining({
        id: "conflict-1",
        authorId: "agent-b",
        acceptedBody: "Saturday games start at 7:00.",
        proposedBody: "Saturday games start at 8:30.",
      }),
    ]);
    const rows = rowsFromFacts(
      boardMemoryFacts([{ memoryFacts: [accepted, proposed, accepted] }]),
      "usba",
      new Set(["fact-accepted", "fact-proposed"]),
    );
    expect(rows.find((row) => row.fact.factId === "fact-proposed")).toMatchObject({
      status: "conflicting",
      meta: { sources: ["agent-b"] },
    });
    expect(stewardNeedsYou(decoded)).toEqual([
      expect.objectContaining({ id: "steward-conflict-conflict-1", actionLabel: "Resolve" }),
      expect.objectContaining({
        id: "steward-write-attempt-a",
        kind: "blocker",
        actionLabel: "Review",
      }),
    ]);
    expect(boardStewardNotices([{ steward: [{ not: "a notice" }] }])).toEqual([]);
  });

  it("shows a conflict from a live project in the drawer with a resolve action", () => {
    const projectId = drawerProjectId("all", [{ id: "qa-live-project" }]);
    expect(projectId).toBe("qa-live-project");
    expect(drawerProjectId("qa-live-project", [{ id: "qa-live-project" }])).toBe("qa-live-project");
    const accepted = {
      acceptance: "accepted" as const,
      factId: "fact-live-accepted",
      projectId,
      kind: "Decision" as const,
      body: "The gate opens at 6.",
      provenance: { actorId: "agent-a", at: "2026-10-24T06:00:00Z" },
      validity: { from: "2026-10-24T06:00:00Z", until: null },
      acceptedBy: "jim",
      acceptedAt: "2026-10-24T06:00:00Z",
    };
    const proposed = {
      acceptance: "proposed" as const,
      factId: "fact-live-proposed",
      projectId,
      kind: "Decision" as const,
      body: "The gate opens at 8.",
      provenance: { actorId: "agent-b", at: "2026-10-24T06:00:00Z" },
      validity: { from: "2026-10-24T06:00:00Z", until: null },
    };
    const notice = {
      noticeId: "steward-conflict-live",
      projectId,
      taskId: "task-live",
      kind: "open_conflict" as const,
      authorId: "agent-b",
      summary:
        "agent-b conflicts with accepted memory: The gate opens at 6. / The gate opens at 8.",
      conflictId: "conflict-live",
      attemptId: "attempt-live",
      acceptedFactId: "fact-live-accepted",
      proposedFactId: "fact-live-proposed",
    };
    const conflicts = stewardConflicts(
      boardStewardNotices([{ steward: [notice] }]),
      [accepted, proposed],
      projectId,
    );
    expect(conflicts).toEqual([
      expect.objectContaining({
        id: "conflict-live",
        projectId: "qa-live-project",
        authorId: "agent-b",
        acceptedBody: "The gate opens at 6.",
        proposedBody: "The gate opens at 8.",
      }),
    ]);
    expect(stewardNeedsYou(boardStewardNotices([{ steward: [notice] }]))).toEqual([
      expect.objectContaining({
        id: "steward-conflict-live",
        kind: "decision",
        actionLabel: "Resolve",
      }),
    ]);
  });
});
