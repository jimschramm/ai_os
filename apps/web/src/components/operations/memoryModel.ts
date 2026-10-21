import { packageFacts, type MemoryFactV1, type MemoryNodeKindV1 } from "@t3tools/ai-os-contracts";

import type { OperationsTask } from "./fixtures";
import {
  AUTHOR_LABELS,
  MEMORY_CONFLICTS,
  MEMORY_GRAPH,
  MEMORY_META,
  SEEDED_REJECTIONS,
  type MemoryConflict,
  type MemoryRecordMeta,
  type MemoryScope,
} from "./memoryFixtures";

export type { MemoryScope };
import { formatInstant } from "./model";

export type MemoryTypeFilter =
  | "instructions"
  | "facts"
  | "decisions"
  | "working-knowledge"
  | "preferences"
  | "handoffs";

export type MemoryStatus = "proposed" | "accepted" | "superseded" | "rejected" | "conflicting";

export type CortexRing = "inner" | "mid" | "outer";

export interface MemoryReviewState {
  readonly rejected: ReadonlySet<string>;
  readonly resolvedConflicts: ReadonlySet<string>;
  readonly corrections: ReadonlySet<string>;
}

export const INITIAL_MEMORY_REVIEW: MemoryReviewState = {
  rejected: new Set(SEEDED_REJECTIONS),
  resolvedConflicts: new Set<string>(),
  corrections: new Set<string>(),
};

export const MEMORY_TYPE_FILTERS = [
  { id: "instructions", label: "Instructions" },
  { id: "facts", label: "Facts" },
  { id: "decisions", label: "Decisions" },
  { id: "working-knowledge", label: "Working knowledge" },
  { id: "preferences", label: "Preferences" },
  { id: "handoffs", label: "Handoffs" },
] as const satisfies readonly { readonly id: MemoryTypeFilter; readonly label: string }[];

export const MEMORY_SCOPE_FILTERS = [
  { id: "personal", label: "Personal" },
  { id: "workspace", label: "Workspace" },
  { id: "project", label: "Project" },
  { id: "task", label: "Current task" },
] as const satisfies readonly { readonly id: MemoryScope; readonly label: string }[];

export const MEMORY_STATUS_FILTERS = [
  { id: "proposed", label: "Proposed" },
  { id: "accepted", label: "Accepted" },
  { id: "superseded", label: "Superseded" },
  { id: "rejected", label: "Rejected" },
  { id: "conflicting", label: "Conflicting" },
] as const satisfies readonly { readonly id: MemoryStatus; readonly label: string }[];

const AS_OF = "2026-10-21T17:00:00Z";

export function factById(factId: string): MemoryFactV1 | undefined {
  return MEMORY_GRAPH.facts.find((fact) => fact.factId === factId);
}

export function metaFor(factId: string): MemoryRecordMeta | undefined {
  return MEMORY_META.find((meta) => meta.factId === factId);
}

export function authorLabel(actorId: string): string {
  return AUTHOR_LABELS[actorId] ?? actorId;
}

export function memoryType(kind: MemoryNodeKindV1): MemoryTypeFilter | "other" {
  switch (kind) {
    case "Instruction":
      return "instructions";
    case "Decision":
      return "decisions";
    case "Handoff":
      return "handoffs";
    case "Procedure":
      return "working-knowledge";
    case "User":
      return "preferences";
    case "Requirement":
    case "Source":
    case "Verification":
      return "facts";
    default:
      return "other";
  }
}

export function cortexRing(kind: MemoryNodeKindV1): CortexRing | "center" {
  switch (kind) {
    case "Project":
      return "center";
    case "Instruction":
    case "Decision":
      return "inner";
    case "Requirement":
    case "Procedure":
    case "User":
    case "Source":
    case "Verification":
      return "mid";
    default:
      return "outer";
  }
}

export function openConflicts(
  projectId: string,
  review: MemoryReviewState,
): readonly MemoryConflict[] {
  return MEMORY_CONFLICTS.filter(
    (conflict) => conflict.projectId === projectId && !review.resolvedConflicts.has(conflict.id),
  );
}

export function conflictingIds(projectId: string, review: MemoryReviewState): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const conflict of openConflicts(projectId, review)) {
    ids.add(conflict.factIds[0]);
    ids.add(conflict.factIds[1]);
  }
  return ids;
}

export function displayStatus(
  fact: MemoryFactV1,
  review: MemoryReviewState,
  conflicts: ReadonlySet<string>,
): MemoryStatus {
  if (review.rejected.has(fact.factId)) return "rejected";
  if (conflicts.has(fact.factId)) return "conflicting";
  return fact.acceptance;
}

export function freshness(fact: MemoryFactV1): string {
  if (fact.acceptance === "superseded" || fact.validity.until !== null) return "Closed";
  if (fact.validity.from >= "2026-10-18T00:00:00Z") return "Fresh";
  return "Standing";
}

export interface MemoryRow {
  readonly fact: MemoryFactV1;
  readonly meta: MemoryRecordMeta;
  readonly status: MemoryStatus;
  readonly type: MemoryTypeFilter | "other";
}

export function memoryRows(projectId: string, review: MemoryReviewState): readonly MemoryRow[] {
  const conflicts = conflictingIds(projectId, review);
  return MEMORY_GRAPH.facts.flatMap((fact) => {
    if (fact.projectId !== projectId) return [];
    const meta = metaFor(fact.factId);
    if (meta === undefined) return [];
    return [
      {
        fact,
        meta,
        status: displayStatus(fact, review, conflicts),
        type: memoryType(fact.kind),
      },
    ];
  });
}

export function filterRows(
  rows: readonly MemoryRow[],
  input: {
    readonly query: string;
    readonly scope: MemoryScope | "all";
    readonly type: MemoryTypeFilter | "all";
    readonly status: MemoryStatus | "all";
    readonly currentTaskId: string | null;
  },
): readonly MemoryRow[] {
  const query = input.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (input.scope === "task") {
      if (input.currentTaskId === null || row.meta.taskId !== input.currentTaskId) return false;
    } else if (input.scope !== "all" && row.meta.scope !== input.scope) {
      return false;
    }
    if (input.type !== "all" && row.type !== input.type) return false;
    if (input.status !== "all" && row.status !== input.status) return false;
    if (query.length === 0) return true;
    const haystack = [
      row.fact.body,
      row.fact.kind,
      row.fact.factId,
      authorLabel(row.fact.provenance.actorId),
      ...row.meta.sources,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function versionChain(factId: string): readonly MemoryFactV1[] {
  const newest = walkToNewest(factId);
  const chain: MemoryFactV1[] = [];
  const seen = new Set<string>();
  let current: string | undefined = newest;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const fact = factById(current);
    if (fact === undefined) break;
    chain.push(fact);
    current = supersededTarget(current);
  }
  return chain;
}

function walkToNewest(factId: string): string {
  const seen = new Set<string>();
  let current = factId;
  while (!seen.has(current)) {
    seen.add(current);
    const newer = MEMORY_GRAPH.relationships.find(
      (relationship) =>
        relationship.relationshipType === "SUPERSEDES" &&
        relationship.acceptance === "accepted" &&
        relationship.toId === current,
    );
    if (newer === undefined) return current;
    current = newer.fromId;
  }
  return current;
}

function supersededTarget(factId: string): string | undefined {
  return MEMORY_GRAPH.relationships.find(
    (relationship) =>
      relationship.relationshipType === "SUPERSEDES" &&
      relationship.acceptance === "accepted" &&
      relationship.fromId === factId,
  )?.toId;
}

export interface LinkedEvidence {
  readonly label: string;
  readonly detail: string;
}

export function linkedEvidence(factId: string): readonly LinkedEvidence[] {
  const meta = metaFor(factId);
  const fromMeta = (meta?.evidence ?? []).map((detail) => ({ label: "Recorded", detail }));
  const fromGraph = MEMORY_GRAPH.relationships.flatMap((relationship) => {
    if (relationship.fromId !== factId) return [];
    if (
      relationship.relationshipType !== "SUPPORTED_BY" &&
      relationship.relationshipType !== "VERIFIED_BY"
    ) {
      return [];
    }
    const target = factById(relationship.toId);
    if (target === undefined) return [];
    const label = relationship.relationshipType === "SUPPORTED_BY" ? "Supported by" : "Verified by";
    return [{ label, detail: target.body }];
  });
  return [...fromGraph, ...fromMeta];
}

export interface ContextPackageView {
  readonly createdAt: string;
  readonly requirements: string;
  readonly authorizationScope: string;
  readonly repoCommit: string;
  readonly versionIds: readonly string[];
  readonly records: readonly MemoryFactV1[];
}

export function contextPackageView(task: OperationsTask): ContextPackageView | null {
  const snapshot = task.assignment?.contextPackage;
  if (snapshot === undefined) return null;
  const records = snapshot.memoryVersions.flatMap((factId) => {
    const fact = factById(factId);
    return fact === undefined ? [] : [fact];
  });
  return {
    createdAt: snapshot.createdAt,
    requirements: snapshot.requirements,
    authorizationScope: snapshot.authorizationScope,
    repoCommit: snapshot.repoCommit,
    versionIds: snapshot.memoryVersions,
    records,
  };
}

export function currentFacts(projectId: string): readonly MemoryFactV1[] {
  return packageFacts(MEMORY_GRAPH, projectId, AS_OF);
}

export const CORTEX_CENTER = { x: 360, y: 360 } as const;
export const CORTEX_RING_RADIUS = { inner: 118, mid: 198, outer: 278 } as const;

export interface CortexNode {
  readonly fact: MemoryFactV1;
  readonly ring: CortexRing;
  readonly x: number;
  readonly y: number;
  readonly status: MemoryStatus;
  readonly dimmed: boolean;
  readonly conflicting: boolean;
}

export interface CortexArc {
  readonly fromId: string;
  readonly toId: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

export function layoutCortex(
  projectId: string,
  review: MemoryReviewState,
  filters: {
    readonly scope: MemoryScope | "all";
    readonly status: MemoryStatus | "all";
    readonly currentTaskId: string | null;
  },
): {
  readonly nodes: readonly CortexNode[];
  readonly arcs: readonly CortexArc[];
  readonly conflictCount: number;
} {
  const rows = filterRows(memoryRows(projectId, review), {
    query: "",
    scope: filters.scope,
    type: "all",
    status: filters.status,
    currentTaskId: filters.currentTaskId,
  }).filter((row) => cortexRing(row.fact.kind) !== "center");
  const grouped = new Map<CortexRing, MemoryRow[]>();
  for (const row of rows) {
    const ring = cortexRing(row.fact.kind);
    if (ring === "center") continue;
    const list = grouped.get(ring) ?? [];
    list.push(row);
    grouped.set(ring, list);
  }
  const nodes: CortexNode[] = [];
  for (const ring of ["inner", "mid", "outer"] as const) {
    const list = grouped.get(ring) ?? [];
    list.forEach((row, index) => {
      const angle = -Math.PI / 2 + (list.length === 0 ? 0 : (index / list.length) * Math.PI * 2);
      const radius = CORTEX_RING_RADIUS[ring];
      nodes.push({
        fact: row.fact,
        ring,
        x: CORTEX_CENTER.x + Math.cos(angle) * radius,
        y: CORTEX_CENTER.y + Math.sin(angle) * radius,
        status: row.status,
        dimmed: row.fact.acceptance === "superseded" || row.status === "rejected",
        conflicting: row.status === "conflicting",
      });
    });
  }
  const byId = new Map(nodes.map((node) => [node.fact.factId, node]));
  const arcs = MEMORY_GRAPH.relationships.flatMap((relationship) => {
    if (relationship.relationshipType !== "SUPERSEDES" || relationship.projectId !== projectId) {
      return [];
    }
    const from = byId.get(relationship.fromId);
    const to = byId.get(relationship.toId);
    if (from === undefined || to === undefined) return [];
    return [
      {
        fromId: relationship.fromId,
        toId: relationship.toId,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
      },
    ];
  });
  return { nodes, arcs, conflictCount: openConflicts(projectId, review).length };
}

export function arcPath(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = 42;
  return `M ${from.x} ${from.y} Q ${midX + (-dy / length) * bend} ${midY + (dx / length) * bend} ${to.x} ${to.y}`;
}

export function formatProvenance(fact: MemoryFactV1): string {
  return `${authorLabel(fact.provenance.actorId)} · ${formatInstant(fact.provenance.at)}`;
}
