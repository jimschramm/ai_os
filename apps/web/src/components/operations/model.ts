import {
  kanbanColumn,
  RECOVERY_PENDING_LABEL,
  usageTotals,
  type KanbanColumn,
  type UsageMeasurementV1,
  type UsageTotals,
} from "@t3tools/ai-os-contracts";

import {
  OPERATIONS_PROJECTS,
  OPERATIONS_TASKS,
  type NeedsYouItem,
  type OperationsAgent,
  type OperationsProject,
  type OperationsProjectId,
  type OperationsTask,
} from "./fixtures";

export const BOARD_COLUMNS = [
  { id: "Ready", label: "Ready", hint: "Assigned or back for another pass" },
  { id: "Running", label: "Running", hint: "Someone is in the work" },
  { id: "Blocked", label: "Blocked", hint: "Includes execution status unknown" },
  { id: "Review", label: "Review", hint: "Waiting on QA" },
  { id: "Done", label: "Done", hint: "Accepted" },
] as const satisfies readonly {
  readonly id: KanbanColumn;
  readonly label: string;
  readonly hint: string;
}[];

export type QaBadgeTone = "secondary" | "info" | "warning" | "success";

export function projects(): readonly OperationsProject[] {
  return OPERATIONS_PROJECTS;
}

export function findProject(id: string): OperationsProject | undefined {
  return OPERATIONS_PROJECTS.find((item) => item.id === id);
}

export function projectById(id: OperationsProjectId): OperationsProject {
  const project = findProject(id);
  if (!project) {
    throw new Error(`Unknown project ${id}`);
  }
  return project;
}

/** Fixture label when the id is one of the sample workspaces; otherwise the id itself. */
export function projectLabel(id: string): string {
  return findProject(id)?.label ?? id;
}

/** One chip per project that actually has a task, in first-seen order. */
export function projectChoices(
  tasks: readonly OperationsTask[],
): readonly { readonly id: string; readonly label: string }[] {
  const ids: string[] = [];
  for (const task of tasks) {
    if (!ids.includes(task.projectId)) ids.push(task.projectId);
  }
  return ids.map((id) => ({ id, label: projectLabel(id) }));
}

export function tasksForProject(id: string): readonly OperationsTask[] {
  return OPERATIONS_TASKS.filter((task) => task.projectId === id);
}

export function columnFor(task: OperationsTask): KanbanColumn | null {
  return kanbanColumn(task.phase);
}

export function tasksInColumn(
  tasks: readonly OperationsTask[],
  column: KanbanColumn,
): readonly OperationsTask[] {
  return tasks.filter((task) => columnFor(task) === column);
}

export function qaStatusLabel(task: OperationsTask): string {
  if (task.phase === "recovery_pending") return RECOVERY_PENDING_LABEL;
  if (task.qa === null) return "Not in review";
  if (task.qa.availability === "unavailable") return "QA unavailable";
  if (task.qa.verdict === "rework") return "Rework";
  return "Accepted";
}

export function qaBadgeTone(task: OperationsTask): QaBadgeTone {
  if (task.phase === "recovery_pending") return "warning";
  if (task.qa === null) return "secondary";
  if (task.qa.availability === "unavailable") return "warning";
  if (task.qa.verdict === "rework") return "warning";
  return "success";
}

export function shortRevision(task: OperationsTask): string {
  const revision = task.revision;
  if (revision === null) return "No revision";
  if (revision.type === "git") return revision.sha.slice(0, 7);
  if (revision.type === "drive") return revision.version.slice(0, 7);
  return revision.id;
}

const MONTHS = [
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
] as const;

export function formatInstant(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  return `${month} ${Number(match[3])}, ${match[4]}:${match[5]} UTC`;
}

export function activeAgentCount(agents: readonly OperationsAgent[]): number {
  return agents.filter((agent) => agent.mode === "active").length;
}

export function needsYou(tasks: readonly OperationsTask[]): readonly NeedsYouItem[] {
  return tasks.flatMap((task) => (task.needsYou === null ? [] : [task.needsYou]));
}

export function recentResults(
  tasks: readonly OperationsTask[],
): readonly { readonly task: OperationsTask; readonly summary: string }[] {
  return tasks.flatMap((task) => (task.result === null ? [] : [{ task, summary: task.result }]));
}

export function usageFor(tasks: readonly OperationsTask[]): {
  readonly entries: readonly UsageMeasurementV1[];
  readonly totals: UsageTotals;
} {
  const entries = tasks.flatMap((task) => task.usage);
  return { entries, totals: usageTotals(entries) };
}

export function contextFactIds(task: OperationsTask): ReadonlySet<string> {
  return new Set(task.assignment?.contextPackage.memoryVersions ?? []);
}

export function formatUsdMinor(amountMinor: number): string {
  const dollars = amountMinor / 100;
  return `$${dollars.toFixed(2)}`;
}

export function formatShare(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
