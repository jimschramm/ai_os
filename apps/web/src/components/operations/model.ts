import {
  kanbanColumn,
  RECOVERY_PENDING_LABEL,
  REWORK_CAP_LABEL,
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
  { id: "Backlog", label: "Backlog", hint: "Requested, not queued yet" },
  { id: "Ready", label: "Ready/Queued", hint: "Assigned or back for another pass" },
  { id: "Running", label: "In Progress", hint: "Someone is in the work" },
  { id: "Review", label: "In QA", hint: "Waiting on an independent review" },
  { id: "Blocked", label: "Blocked", hint: "Execution status unknown, or needs Jim" },
  { id: "Done", label: "Done", hint: "Accepted by a different model" },
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

/**
 * T3 project title when `names` has the id, otherwise the fixture label.
 * An unknown id stays visible as itself until the project list arrives.
 */
export function projectLabel(id: string, names?: ReadonlyMap<string, string>): string {
  const named = names?.get(id);
  if (named !== undefined && named.length > 0) return named;
  return findProject(id)?.label ?? id;
}

/** One entry per project that actually has a task, in first-seen order. */
export function projectChoices(
  tasks: readonly OperationsTask[],
  names?: ReadonlyMap<string, string>,
): readonly { readonly id: string; readonly label: string }[] {
  const ids: string[] = [];
  for (const task of tasks) {
    if (!ids.includes(task.projectId)) ids.push(task.projectId);
  }
  return ids.map((id) => ({ id, label: projectLabel(id, names) }));
}

export function tasksForProject(id: string): readonly OperationsTask[] {
  return OPERATIONS_TASKS.filter((task) => task.projectId === id);
}

export function columnFor(task: OperationsTask): KanbanColumn | null {
  return kanbanColumn(task.phase);
}

export function assignedAgent(task: OperationsTask): string {
  return task.assignment?.workerId ?? task.agent;
}

export function assignedModel(task: OperationsTask): string {
  return task.assignment?.implementerModel.model ?? "Unassigned";
}

/** The newest thing the run has said, otherwise the request itself. */
export function progressLine(task: OperationsTask): string {
  const latest = task.progress.at(-1);
  const note = latest?.partialArtifacts.at(-1)?.note;
  if (note !== undefined) return note;
  const blocker = latest?.blockers.at(-1)?.summary;
  if (blocker !== undefined) return blocker;
  if (task.result !== null) return task.result;
  return task.intake.request;
}

export function blockerReason(task: OperationsTask): string | null {
  if (task.needsYou !== null) return task.needsYou.summary;
  const latest = task.progress.at(-1);
  if (latest?.status !== "blocked") return null;
  return latest.blockers[0]?.summary ?? null;
}

export function tasksInColumn(
  tasks: readonly OperationsTask[],
  column: KanbanColumn,
): readonly OperationsTask[] {
  return tasks.filter((task) => columnFor(task) === column);
}

export function qaStatusLabel(task: OperationsTask): string {
  if (task.phase === "rework_capped") return REWORK_CAP_LABEL;
  if (task.phase === "recovery_pending") return RECOVERY_PENDING_LABEL;
  if (task.qa === null) return "Not in review";
  if (task.qa.availability === "unavailable") return "QA unavailable";
  if (task.qa.verdict === "rework") return "Rework";
  return "Accepted";
}

export function qaBadgeTone(task: OperationsTask): QaBadgeTone {
  if (task.phase === "rework_capped" || task.phase === "recovery_pending") return "warning";
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
