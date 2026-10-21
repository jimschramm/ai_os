import type { MemoryNodeKindV1 } from "@t3tools/ai-os-contracts";

import { MEMORY_GRAPH } from "./memoryFixtures";
import {
  arcPath,
  memoryRows,
  openConflicts,
  type MemoryReviewState,
  type MemoryStatus,
} from "./memoryModel";

export const CORTEX_NODE_COUNT = 4_999;
export const CORTEX_LINK_COUNT = 7_240;
export const FULL_SHOWN = 162;
export const CORTEX_HUB = { x: 470, y: 290 } as const;

export type ClusterId =
  | "instructions"
  | "decisions"
  | "facts"
  | "working"
  | "preferences"
  | "handoffs"
  | "tasks"
  | "artifacts";

export type DetailLevel = "macro" | "mid" | "micro" | "full";

export const DETAIL_LEVELS = [
  { id: "macro", label: "Macro" },
  { id: "mid", label: "Mid" },
  { id: "micro", label: "Micro" },
  { id: "full", label: "Full" },
] as const satisfies readonly { readonly id: DetailLevel; readonly label: string }[];

export const CLUSTER_KINDS = [
  {
    id: "instructions",
    label: "Instructions",
    color: "var(--ops-cluster-white)",
    count: 412,
    x: 500,
    y: 78,
  },
  {
    id: "decisions",
    label: "Decisions",
    color: "var(--ops-cluster-amber)",
    count: 638,
    x: 710,
    y: 168,
  },
  { id: "facts", label: "Facts", color: "var(--ops-cluster-yellow)", count: 974, x: 748, y: 340 },
  {
    id: "working",
    label: "Working knowledge",
    color: "var(--ops-cluster-mint)",
    count: 706,
    x: 640,
    y: 468,
  },
  {
    id: "preferences",
    label: "Preferences",
    color: "var(--ops-cluster-pink)",
    count: 388,
    x: 430,
    y: 488,
  },
  {
    id: "handoffs",
    label: "Handoffs",
    color: "var(--ops-cluster-violet)",
    count: 451,
    x: 250,
    y: 420,
  },
  { id: "tasks", label: "Tasks", color: "var(--ops-cluster-blue)", count: 872, x: 210, y: 250 },
  {
    id: "artifacts",
    label: "Artifacts",
    color: "var(--ops-cluster-sky)",
    count: 558,
    x: 330,
    y: 118,
  },
] as const satisfies readonly {
  readonly id: ClusterId;
  readonly label: string;
  readonly color: string;
  readonly count: number;
  readonly x: number;
  readonly y: number;
}[];

export const MEMORY_SOURCES = [
  {
    id: "grok-bot",
    label: "Grok Bot",
    mark: "G",
    count: 812,
    freshMin: 4,
    color: "var(--ops-cluster-amber)",
  },
  {
    id: "codex-t3",
    label: "Codex via T3",
    mark: "C",
    count: 946,
    freshMin: 2,
    color: "var(--ops-cluster-blue)",
  },
  {
    id: "codex-vscode",
    label: "Codex in VS Code",
    mark: "V",
    count: 604,
    freshMin: 11,
    color: "var(--ops-cluster-mint)",
  },
  {
    id: "tam",
    label: "TAM",
    mark: "T",
    count: 533,
    freshMin: 8,
    color: "var(--ops-cluster-violet)",
  },
  {
    id: "google-drive",
    label: "Google Drive",
    mark: "D",
    count: 488,
    freshMin: 18,
    color: "var(--ops-cluster-yellow)",
  },
  {
    id: "github",
    label: "GitHub",
    mark: "H",
    count: 701,
    freshMin: 6,
    color: "var(--ops-cluster-white)",
  },
  {
    id: "vault",
    label: "Vault",
    mark: "Va",
    count: 362,
    freshMin: 25,
    color: "var(--ops-cluster-sky)",
  },
  {
    id: "web",
    label: "Web",
    mark: "W",
    count: 297,
    freshMin: 14,
    color: "var(--ops-cluster-mint)",
  },
  {
    id: "marketing",
    label: "Marketing",
    mark: "M",
    count: 256,
    freshMin: 9,
    color: "var(--ops-cluster-pink)",
  },
] as const;

export type MemorySourceId = (typeof MEMORY_SOURCES)[number]["id"];

const SOURCE_BY_FACT: Readonly<Record<string, MemorySourceId>> = {
  "fact-personal-replies": "grok-bot",
  "fact-personal-notes": "vault",
  "fact-personal-pref": "grok-bot",
  "fact-workspace-voice": "marketing",
  "fact-governing-copy": "tam",
  "fact-saturday-start": "tam",
  "fact-saturday-830": "google-drive",
  "fact-friday-7": "tam",
  "fact-friday-6": "grok-bot",
  "fact-gym": "google-drive",
  "fact-hero-photo": "google-drive",
  "fact-score-sheet": "vault",
  "fact-verify-schedule": "tam",
  "fact-procedure-publish": "web",
  "fact-preference-photo": "marketing",
  "fact-handoff-schedule": "codex-t3",
  "fact-task-saturday": "tam",
  "fact-attempt-saturday": "codex-t3",
  "fact-artifact-schedule": "github",
  "fact-banner-proposed": "grok-bot",
  "fact-candidates-are-not-context": "github",
  "fact-mockup-is-static": "codex-vscode",
  "fact-ai-procedure": "codex-vscode",
  "fact-ai-task": "github",
};

export function memorySourceFor(factId: string): MemorySourceId | null {
  return SOURCE_BY_FACT[factId] ?? null;
}

export function defaultSourceToggles(): Record<MemorySourceId, boolean> {
  return {
    "grok-bot": true,
    "codex-t3": true,
    "codex-vscode": true,
    tam: true,
    "google-drive": true,
    github: true,
    vault: true,
    web: true,
    marketing: true,
  };
}

export function clusterForKind(kind: MemoryNodeKindV1): ClusterId | null {
  switch (kind) {
    case "Project":
      return null;
    case "Instruction":
      return "instructions";
    case "Decision":
      return "decisions";
    case "Requirement":
    case "Source":
    case "Verification":
    case "Repository":
    case "Environment":
      return "facts";
    case "Procedure":
    case "Agent":
      return "working";
    case "User":
      return "preferences";
    case "Handoff":
      return "handoffs";
    case "Task":
    case "Attempt":
      return "tasks";
    case "Artifact":
      return "artifacts";
  }
}

export interface FieldRecord {
  readonly factId: string;
  readonly body: string;
  readonly clusterId: ClusterId;
  readonly sourceId: MemorySourceId;
  readonly status: MemoryStatus;
  readonly x: number;
  readonly y: number;
  readonly at: string;
  readonly dimmed: boolean;
  readonly conflicting: boolean;
}

export interface FieldArc {
  readonly id: string;
  readonly kind: "supersede" | "conflict";
  readonly clusterId: ClusterId | null;
  readonly fromId: string;
  readonly toId: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

export interface SatelliteDot {
  readonly id: string;
  readonly clusterId: ClusterId;
  readonly sourceId: MemorySourceId;
  readonly x: number;
  readonly y: number;
}

export interface CortexField {
  readonly satellites: readonly SatelliteDot[];
  readonly records: readonly FieldRecord[];
  readonly arcs: readonly FieldArc[];
  readonly hubLinks: readonly { readonly clusterId: ClusterId; readonly d: string }[];
  readonly neighborLinks: readonly { readonly id: string; readonly d: string }[];
  readonly shown: number;
}

export function satelliteBudget(level: DetailLevel, pinned: number): number {
  if (level === "macro") return 0;
  if (level === "mid") return 32;
  if (level === "micro") return 80;
  return Math.max(0, FULL_SHOWN - CLUSTER_KINDS.length - pinned);
}

// The catalog is 4,999 nodes. Painting every node would stall the page, so a
// detail level draws the kind clusters plus a capped satellite sample. Real
// records stay in that sample so a click can still open them.
export function neuralField(input: {
  readonly projectId: string;
  readonly review: MemoryReviewState;
  readonly level: DetailLevel;
  readonly enabledSources: ReadonlySet<string>;
  readonly query: string;
}): CortexField {
  const pinned = placeRecords(input.projectId, input.review);
  const budget = satelliteBudget(input.level, pinned.length);
  const satellites = placeSatellites(budget).filter((dot) =>
    input.enabledSources.has(dot.sourceId),
  );
  const records = pinned.filter(
    (record) =>
      input.enabledSources.has(record.sourceId) &&
      matchesQuery(input.query, record.body, record.factId),
  );
  const visible = new Map(records.map((record) => [record.factId, record]));
  const arcs = fieldArcs(input.projectId, input.review, visible);
  const clustersOn = input.enabledSources.size > 0;
  return {
    satellites: clustersOn ? satellites : [],
    records: clustersOn ? records : [],
    arcs: clustersOn ? arcs : [],
    hubLinks: clustersOn ? hubLinks() : [],
    neighborLinks: clustersOn ? neighborLinks() : [],
    shown: clustersOn ? CLUSTER_KINDS.length + satellites.length + records.length : 0,
  };
}

export interface TimelineLayout {
  readonly nodes: readonly FieldRecord[];
  readonly arcs: readonly FieldArc[];
  readonly lanes: readonly { readonly id: ClusterId; readonly label: string; readonly y: number }[];
  readonly startLabel: string;
  readonly endLabel: string;
}

export function timelineField(input: {
  readonly projectId: string;
  readonly review: MemoryReviewState;
  readonly enabledSources: ReadonlySet<string>;
  readonly query: string;
}): TimelineLayout {
  const pinned = placeRecords(input.projectId, input.review).filter(
    (record) =>
      input.enabledSources.has(record.sourceId) &&
      matchesQuery(input.query, record.body, record.factId),
  );
  const laneIds = CLUSTER_KINDS.map((cluster) => cluster.id).filter((id) =>
    pinned.some((record) => record.clusterId === id),
  );
  const lanes = laneIds.map((id, index) => ({
    id,
    label: CLUSTER_KINDS.find((cluster) => cluster.id === id)?.label ?? id,
    y: 56 + index * 62,
  }));
  const laneY = new Map(lanes.map((lane) => [lane.id, lane.y]));
  const times = pinned.map((record) => Date.parse(record.at));
  const min = times.length === 0 ? 0 : Math.min(...times);
  const max = times.length === 0 ? 1 : Math.max(...times);
  const span = Math.max(max - min, 1);
  const nodes = pinned.map((record) => {
    const t = Date.parse(record.at);
    const x = pinned.length === 1 ? 500 : 96 + ((t - min) / span) * 820;
    return { ...record, x, y: laneY.get(record.clusterId) ?? 56 };
  });
  const visible = new Map(nodes.map((record) => [record.factId, record]));
  const ordered = [...nodes].sort((a, b) => a.at.localeCompare(b.at));
  return {
    nodes,
    arcs: fieldArcs(input.projectId, input.review, visible),
    lanes,
    startLabel: ordered[0] ? shortDay(ordered[0].at) : "",
    endLabel: ordered.length > 1 ? shortDay(ordered[ordered.length - 1]!.at) : "",
  };
}

export function matchesQuery(query: string, body: string, factId: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return body.toLowerCase().includes(needle) || factId.toLowerCase().includes(needle);
}

function placeRecords(projectId: string, review: MemoryReviewState): readonly FieldRecord[] {
  const grouped = new Map<ClusterId, FieldRecord[]>();
  for (const row of memoryRows(projectId, review)) {
    const clusterId = clusterForKind(row.fact.kind);
    const sourceId = memorySourceFor(row.fact.factId);
    if (clusterId === null || sourceId === null) continue;
    const list = grouped.get(clusterId) ?? [];
    list.push({
      factId: row.fact.factId,
      body: row.fact.body,
      clusterId,
      sourceId,
      status: row.status,
      x: 0,
      y: 0,
      at: row.fact.provenance.at,
      dimmed: row.fact.acceptance === "superseded" || row.status === "rejected",
      conflicting: row.status === "conflicting",
    });
    grouped.set(clusterId, list);
  }
  const placed: FieldRecord[] = [];
  for (const cluster of CLUSTER_KINDS) {
    const list = grouped.get(cluster.id) ?? [];
    list.forEach((record, index) => {
      const angle = -Math.PI / 2 + ((index + 0.5) / Math.max(list.length, 1)) * Math.PI * 2;
      const radius = 38 + (index % 3) * 12;
      placed.push({
        ...record,
        x: clamp(cluster.x + Math.cos(angle) * radius, 28, 972),
        y: clamp(cluster.y + Math.sin(angle) * radius, 28, 560),
      });
    });
  }
  return placed;
}

function placeSatellites(budget: number): readonly SatelliteDot[] {
  const dots: SatelliteDot[] = [];
  for (let index = 0; index < budget; index += 1) {
    const cluster = CLUSTER_KINDS[index % CLUSTER_KINDS.length]!;
    const source = MEMORY_SOURCES[index % MEMORY_SOURCES.length]!;
    const rand = mulberry32(index * 97 + 11);
    const angle = rand() * Math.PI * 2;
    const radius = 20 + rand() * 50;
    dots.push({
      id: `sat-${index}`,
      clusterId: cluster.id,
      sourceId: source.id,
      x: clamp(cluster.x + Math.cos(angle) * radius, 16, 984),
      y: clamp(cluster.y + Math.sin(angle) * radius, 16, 568),
    });
  }
  return dots;
}

function fieldArcs(
  projectId: string,
  review: MemoryReviewState,
  visible: ReadonlyMap<string, FieldRecord>,
): readonly FieldArc[] {
  const supersede = MEMORY_GRAPH.relationships.flatMap((relationship) => {
    if (relationship.relationshipType !== "SUPERSEDES" || relationship.projectId !== projectId) {
      return [];
    }
    return arcBetween("supersede", relationship.fromId, relationship.toId, visible);
  });
  const conflicts = openConflicts(projectId, review).flatMap((conflict) =>
    arcBetween("conflict", conflict.factIds[0], conflict.factIds[1], visible),
  );
  return [...supersede, ...conflicts];
}

function arcBetween(
  kind: FieldArc["kind"],
  fromId: string,
  toId: string,
  visible: ReadonlyMap<string, FieldRecord>,
): readonly FieldArc[] {
  const from = visible.get(fromId);
  const to = visible.get(toId);
  if (from === undefined || to === undefined) return [];
  return [
    {
      id: `${kind}:${fromId}:${toId}`,
      kind,
      clusterId: from.clusterId === to.clusterId ? from.clusterId : null,
      fromId,
      toId,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
    },
  ];
}

function hubLinks(): readonly { readonly clusterId: ClusterId; readonly d: string }[] {
  return CLUSTER_KINDS.map((cluster) => ({
    clusterId: cluster.id,
    d: arcPath({ x: cluster.x, y: cluster.y }, CORTEX_HUB),
  }));
}

function neighborLinks(): readonly { readonly id: string; readonly d: string }[] {
  return CLUSTER_KINDS.map((cluster, index) => {
    const next = CLUSTER_KINDS[(index + 1) % CLUSTER_KINDS.length]!;
    return { id: `${cluster.id}-${next.id}`, d: arcPath(cluster, next) };
  });
}

function shortDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
