import type { SequencePhase, UsageMeasurementV1 } from "@t3tools/ai-os-contracts";

import type { OperationsTask } from "./fixtures";

export const WEEKLY_COST_CAP_MINOR = 200;

const AGENT_ORDER = [
  "grok-bot",
  "codex-t3",
  "codex-vscode",
  "qa-reviewer",
  "vault",
  "web",
  "marketing",
] as const;

const AGENT_FACE: Readonly<Record<string, { readonly label: string; readonly mark: string }>> = {
  "grok-bot": { label: "Grok Bot", mark: "G" },
  "codex-t3": { label: "Codex via T3", mark: "C" },
  "codex-vscode": { label: "Codex in VS Code", mark: "V" },
  "qa-reviewer": { label: "QA reviewer", mark: "Q" },
  vault: { label: "Vault", mark: "Va" },
  web: { label: "Web", mark: "W" },
  marketing: { label: "Marketing", mark: "M" },
};

export type GaugeCaption = "reported tokens" | "subscription" | "estimated" | "unknown";

export interface ProviderGauge {
  readonly agentId: string;
  readonly label: string;
  readonly mark: string;
  readonly reportedTokens: number;
  readonly estimatedCostMinor: number;
  readonly subscriptionBps: number;
  readonly unknown: number;
  readonly tokenRatio: number;
  readonly costRatio: number;
  readonly subscriptionRatio: number;
  readonly liquid: number;
  readonly percent: string;
  readonly caption: GaugeCaption;
  readonly unknownOnly: boolean;
}

export function providerGauges(entries: readonly UsageMeasurementV1[]): readonly ProviderGauge[] {
  const buckets = new Map<
    string,
    { reported: number; cost: number; sub: number; unknown: number }
  >();
  for (const entry of entries) {
    const id = entry.attribution.agentId;
    const bucket = buckets.get(id) ?? { reported: 0, cost: 0, sub: 0, unknown: 0 };
    switch (entry.kind) {
      case "reported_tokens":
        bucket.reported += entry.inputTokens + entry.outputTokens;
        break;
      case "estimated_cost":
        bucket.cost += entry.amountMinor;
        break;
      case "subscription_allocation":
        bucket.sub += entry.shareBps;
        break;
      case "unknown":
        bucket.unknown += 1;
        break;
    }
    buckets.set(id, bucket);
  }
  const workspaceReported = [...buckets.values()].reduce((sum, bucket) => sum + bucket.reported, 0);
  return [...buckets.keys()]
    .sort((a, b) => agentRank(a) - agentRank(b))
    .map((agentId) => {
      const bucket = buckets.get(agentId)!;
      const face = AGENT_FACE[agentId] ?? {
        label: agentId,
        mark: agentId.slice(0, 1).toUpperCase(),
      };
      const tokenRatio = workspaceReported === 0 ? 0 : bucket.reported / workspaceReported;
      const costRatio = Math.min(1, bucket.cost / WEEKLY_COST_CAP_MINOR);
      const subscriptionRatio = Math.min(1, bucket.sub / 10_000);
      const unknownOnly =
        bucket.reported === 0 && bucket.cost === 0 && bucket.sub === 0 && bucket.unknown > 0;
      const primary = primaryKind(bucket, tokenRatio, costRatio, subscriptionRatio, unknownOnly);
      return {
        agentId,
        label: face.label,
        mark: face.mark,
        reportedTokens: bucket.reported,
        estimatedCostMinor: bucket.cost,
        subscriptionBps: bucket.sub,
        unknown: bucket.unknown,
        tokenRatio,
        costRatio,
        subscriptionRatio,
        liquid: primary.liquid,
        percent: primary.percent,
        caption: primary.caption,
        unknownOnly,
      };
    });
}

function primaryKind(
  bucket: { reported: number; cost: number; sub: number; unknown: number },
  tokenRatio: number,
  costRatio: number,
  subscriptionRatio: number,
  unknownOnly: boolean,
): { readonly liquid: number; readonly percent: string; readonly caption: GaugeCaption } {
  if (bucket.reported > 0) {
    return { liquid: tokenRatio, percent: percentOf(tokenRatio), caption: "reported tokens" };
  }
  if (bucket.sub > 0) {
    return {
      liquid: subscriptionRatio,
      percent: percentOf(subscriptionRatio),
      caption: "subscription",
    };
  }
  if (bucket.cost > 0) {
    return { liquid: costRatio, percent: percentOf(costRatio), caption: "estimated" };
  }
  if (unknownOnly) return { liquid: 0, percent: "—", caption: "unknown" };
  return { liquid: 0, percent: "0%", caption: "unknown" };
}

function percentOf(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function agentRank(agentId: string): number {
  const index = AGENT_ORDER.indexOf(agentId as (typeof AGENT_ORDER)[number]);
  return index === -1 ? AGENT_ORDER.length : index;
}

export interface QaBreakdown {
  readonly accept: number;
  readonly rework: number;
  readonly unavailable: number;
  readonly open: number;
}

export function qaBreakdown(tasks: readonly OperationsTask[]): QaBreakdown {
  let accept = 0;
  let rework = 0;
  let unavailable = 0;
  let open = 0;
  for (const task of tasks) {
    if (task.qa === null) open += 1;
    else if (task.qa.availability === "unavailable") unavailable += 1;
    else if (task.qa.verdict === "rework") rework += 1;
    else accept += 1;
  }
  return { accept, rework, unavailable, open };
}

export function findingsCount(task: OperationsTask): number {
  if (task.qa === null || task.qa.availability !== "available") return 0;
  return task.qa.findings.length;
}

const HOURS = [10, 11, 12, 13, 14, 15, 16, 17] as const;

export function touchSeries(tasks: readonly OperationsTask[]): readonly number[] {
  return HOURS.map(
    (hour) =>
      tasks.filter((task) => {
        if (!task.updatedAt.startsWith("2026-10-21")) return false;
        const match = /T(\d{2}):/.exec(task.updatedAt);
        return match !== null && Number(match[1]) === hour;
      }).length,
  );
}

export const PROGRESS_STEPS = [
  { id: "intake", label: "Intake" },
  { id: "assignment", label: "Assignment" },
  { id: "executing", label: "Executing" },
  { id: "qa", label: "QA" },
  { id: "rework", label: "Rework" },
  { id: "accepted", label: "Accepted" },
] as const;

export function progressIndex(phase: SequencePhase): {
  readonly index: number;
  readonly stalled: boolean;
} {
  switch (phase) {
    case "idle":
    case "requested":
      return { index: 0, stalled: false };
    case "acknowledged":
    case "assigned":
      return { index: 1, stalled: false };
    case "executing":
      return { index: 2, stalled: false };
    case "recovery_pending":
      return { index: 2, stalled: true };
    case "awaiting_qa":
      return { index: 3, stalled: false };
    case "qa_incomplete":
      return { index: 3, stalled: true };
    case "rework":
      return { index: 4, stalled: false };
    case "rework_capped":
      return { index: 4, stalled: true };
    case "accepted":
    case "review_delivered":
      return { index: 5, stalled: false };
    case "failed":
    case "cancelled":
      return { index: 2, stalled: true };
  }
}

const PROGRESS_PERCENT = {
  idle: 6,
  requested: 12,
  acknowledged: 20,
  assigned: 28,
  executing: 55,
  recovery_pending: 48,
  awaiting_qa: 80,
  qa_incomplete: 80,
  rework: 62,
  rework_capped: 48,
  accepted: 100,
  review_delivered: 100,
  failed: 48,
  cancelled: 20,
} as const satisfies Record<SequencePhase, number>;

export function progressPercent(phase: SequencePhase): number {
  return PROGRESS_PERCENT[phase];
}

export function agentColor(name: string): string {
  switch (name) {
    case "Grok Bot":
      return "var(--ops-cluster-amber)";
    case "Codex via T3":
      return "var(--ops-cluster-blue)";
    case "Codex in VS Code":
      return "var(--ops-cluster-mint)";
    case "QA reviewer":
      return "var(--ops-cluster-violet)";
    case "Vault":
      return "var(--ops-cluster-yellow)";
    case "Web":
      return "var(--ops-cluster-sky)";
    case "Marketing":
      return "var(--ops-cluster-pink)";
    default:
      return "var(--ops-cluster-blue)";
  }
}

export function agentMark(name: string): string {
  switch (name) {
    case "Grok Bot":
      return "G";
    case "Codex via T3":
      return "C";
    case "Codex in VS Code":
      return "V";
    case "QA reviewer":
      return "Q";
    case "Vault":
      return "Va";
    case "Web":
      return "W";
    case "Marketing":
      return "M";
    default:
      return name.slice(0, 1);
  }
}
