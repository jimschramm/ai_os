import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CircleAlertIcon, CircleHelpIcon } from "lucide-react";
import { createContext, useContext, useRef, useState, type ReactNode, type RefObject } from "react";

import { useProjects } from "../../state/entities";

import {
  PROGRESS_STEPS,
  agentColor,
  agentMark,
  findingsCount,
  progressIndex,
  qaBreakdown,
  touchSeries,
} from "./boardVisuals";
import { ContextPackageView } from "./ContextPackageView";
import { useDialogCycle } from "./dialogFocus";
import { CortexView } from "./CortexView";
import { MemoryBrowser } from "./MemoryBrowser";
import { UsageGauges } from "./UsageGauges";
import { AdvisoryReviewSection } from "./AdvisoryReview";
import { hasLiveBoard, tasksForBoard } from "./adapterBoard";
import { KanbanBoard } from "./KanbanBoard";
import { useAdapterBoard } from "./adapterFeed";
import type { NeedsYouItem, OperationsAgent, OperationsTask } from "./fixtures";
import { INITIAL_MEMORY_REVIEW, boardAttemptActivity, type MemoryReviewState } from "./memoryModel";
import {
  activeAgentCount,
  findProject,
  needsYou,
  projectById,
  projectChoices,
  projectLabel,
  qaBadgeTone,
  qaStatusLabel,
  shortRevision,
  tasksInColumn,
  usageFor,
} from "./model";

const ALL_PROJECTS = "all";
const EMPTY_PROJECT_NAMES: ReadonlyMap<string, string> = new Map();
const ProjectNames = createContext(EMPTY_PROJECT_NAMES);

export function ProvideOperationsProjectNames({
  names,
  children,
}: {
  names: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  return <ProjectNames.Provider value={names}>{children}</ProjectNames.Provider>;
}

/** Titles from the connected T3 project list, so a live id shows as aios-test rather than a uuid. */
export function OperationsProjectNamesFromServer({ children }: { children: ReactNode }) {
  const projects = useProjects();
  const names = new Map<string, string>(projects.map((project) => [project.id, project.title]));
  return <ProvideOperationsProjectNames names={names}>{children}</ProvideOperationsProjectNames>;
}

const useProjectNames = (): ReadonlyMap<string, string> => useContext(ProjectNames);

export function OperationsDashboard() {
  const names = useProjectNames();
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
  const [demoData, setDemoData] = useState(false);
  const [surface, setSurface] = useState<"board" | "memory">("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [noted, setNoted] = useState<Readonly<Record<string, true>>>({});
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryId, setMemoryId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>("fact-friday-7");
  const [review, setReview] = useState<MemoryReviewState>(INITIAL_MEMORY_REVIEW);
  const [memoryNotes, setMemoryNotes] = useState<Readonly<Record<string, string>>>({});
  const cards = useAdapterBoard();
  const live = hasLiveBoard(cards);
  const includeFixtures = !live || (import.meta.env.DEV && demoData);
  const allTasks = tasksForBoard(undefined, cards, includeFixtures);
  const choices = projectChoices(allTasks, names);
  const workspace =
    projectFilter !== ALL_PROJECTS && choices.some((choice) => choice.id === projectFilter)
      ? projectFilter
      : ALL_PROJECTS;
  const tasks =
    workspace === ALL_PROJECTS ? allTasks : tasksForBoard(workspace, cards, includeFixtures);
  const memoryProject =
    (workspace === ALL_PROJECTS ? undefined : findProject(workspace)) ??
    choices.map((choice) => findProject(choice.id)).find((project) => project !== undefined) ??
    projectById("personal");
  const agents =
    live && !includeFixtures
      ? agentsFromTasks(tasks)
      : workspace === ALL_PROJECTS
        ? agentsForChoices(choices)
        : (findProject(workspace)?.agents ?? []);
  const heading = workspace === ALL_PROJECTS ? "All projects" : projectLabel(workspace, names);
  const detail =
    workspace === ALL_PROJECTS ? "All projects" : (findProject(workspace)?.detail ?? heading);
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const currentTask = tasks.find((task) => task.id === currentTaskId) ?? null;
  const openMemory = (factId: string | null) => {
    setSelectedId(null);
    setMemoryId(factId);
    setMemoryOpen(true);
  };
  const showRelationships = (factId: string | null) => {
    setHighlightId(factId ?? "fact-friday-7");
    setSurface("memory");
    setMemoryOpen(false);
  };
  const attention = needsYou(tasks);
  const usage = usageFor(tasks);
  const active = activeAgentCount(agents);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-clip bg-background text-foreground">
      <header className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground">{detail}</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Operations</h1>
            <div role="tablist" aria-label="Views" className="mt-3 flex flex-wrap gap-2">
              <Button
                role="tab"
                aria-selected={surface === "board"}
                size="sm"
                variant={surface === "board" ? "secondary" : "outline"}
                onClick={() => setSurface("board")}
              >
                Board
              </Button>
              <Button
                role="tab"
                aria-selected={surface === "memory"}
                size="sm"
                variant={surface === "memory" ? "secondary" : "outline"}
                onClick={() => setSurface("memory")}
              >
                Memory
              </Button>
            </div>
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <ProjectPicker selected={workspace} choices={choices} onChange={setProjectFilter} />
            {import.meta.env.DEV && live ? (
              <label className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <input
                  aria-label="Demo data"
                  type="checkbox"
                  checked={demoData}
                  onChange={(event) => setDemoData(event.currentTarget.checked)}
                />
                Demo data
              </label>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => openMemory(null)}>
              Browse memory
            </Button>
          </div>
        </div>
      </header>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        {surface === "memory" ? (
          <div className="p-4 sm:p-6">
            <CortexView
              projectId={memoryProject.id}
              projectLabel={memoryProject.label}
              review={review}
              highlightId={highlightId}
              currentTaskId={currentTaskId}
              onOpenRecord={openMemory}
            />
          </div>
        ) : (
          <div className="ops-visual flex min-w-0 flex-col gap-4 p-4 sm:p-6">
            <AgentRail agents={agents} active={active} />
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <ThroughputCard tasks={tasks} />
              <QaCard tasks={tasks} />
              <BlockerCard
                items={attention}
                noted={noted}
                onAct={(id) => setNoted((current) => ({ ...current, [id]: true }))}
              />
            </div>
            <section aria-labelledby="board-heading" className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 id="board-heading" className="text-sm font-semibold tracking-tight">
                  Board
                </h2>
                <p id="board-filter-label" className="text-xs text-muted-foreground">
                  {heading}
                </p>
              </div>
              <KanbanBoard
                tasks={tasks}
                liveIds={new Set(cards.map((card) => card.taskId))}
                names={names}
                onOpen={(taskId) => {
                  setCurrentTaskId(taskId);
                  setSelectedId(taskId);
                }}
              />
            </section>
            <UsageGauges entries={usage.entries} />
          </div>
        )}
      </main>
      <TaskDrawer
        task={selected}
        live={selected !== null && cards.some((card) => card.taskId === selected.id)}
        onClose={() => setSelectedId(null)}
        onOpenRecord={(factId) => {
          if (selected !== null) setCurrentTaskId(selected.id);
          openMemory(factId);
        }}
      />
      <MemoryBrowser
        open={memoryOpen}
        projectId={memoryProject.id}
        projectLabel={memoryProject.label}
        currentTaskId={currentTaskId}
        currentTaskTitle={currentTask?.title ?? null}
        activity={boardAttemptActivity(cards)}
        review={review}
        selectedId={memoryId}
        notes={memoryNotes}
        onSelect={setMemoryId}
        onClose={() => setMemoryOpen(false)}
        onShowRelationships={showRelationships}
        onReject={(factId) => {
          setReview((current) => ({
            ...current,
            rejected: new Set([...current.rejected, factId]),
          }));
          setMemoryNotes((current) => ({
            ...current,
            [factId]: "Rejected. This mockup does not send the decision.",
          }));
        }}
        onResolve={(conflictId, keptId) => {
          setReview((current) => ({
            ...current,
            resolvedConflicts: new Set([...current.resolvedConflicts, conflictId]),
          }));
          const note =
            keptId === null
              ? "Conflict marked resolved. Nothing was saved."
              : "Kept that claim. Nothing was saved.";
          setMemoryNotes((current) => ({ ...current, [conflictId]: note }));
        }}
        onCorrect={(factId) => {
          setReview((current) => ({
            ...current,
            corrections: new Set([...current.corrections, factId]),
          }));
        }}
      />
    </div>
  );
}

function ProjectPicker({
  selected,
  choices,
  onChange,
}: {
  selected: string;
  choices: readonly { readonly id: string; readonly label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <select
      aria-label="Projects"
      value={selected}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-7 max-w-56 rounded-md border border-border bg-background px-2 text-xs text-foreground"
    >
      <option value={ALL_PROJECTS}>All projects</option>
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

function agentsFromTasks(tasks: readonly OperationsTask[]): readonly OperationsAgent[] {
  const byName = new Map<string, OperationsAgent>();
  for (const task of tasks) {
    const active =
      task.phase === "executing" || task.phase === "assigned" || task.phase === "rework";
    const existing = byName.get(task.agent);
    if (existing === undefined) {
      byName.set(task.agent, {
        id: task.agent,
        name: task.agent,
        surface: task.surface,
        mode: active ? "active" : "update-only",
        assignment: task.title,
      });
    } else if (active && existing.mode !== "active") {
      byName.set(task.agent, { ...existing, mode: "active", assignment: task.title });
    }
  }
  return [...byName.values()];
}

function agentsForChoices(choices: readonly { readonly id: string }[]): readonly OperationsAgent[] {
  const seen = new Set<string>();
  const agents: OperationsAgent[] = [];
  for (const choice of choices) {
    const project = findProject(choice.id);
    if (project === undefined) continue;
    for (const agent of project.agents) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      agents.push(agent);
    }
  }
  return agents;
}

function AgentRail({ active, agents }: { active: number; agents: readonly OperationsAgent[] }) {
  return (
    <section
      aria-labelledby="agents-heading"
      className="rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="agents-heading" className="text-sm font-semibold tracking-tight">
          Agents
        </h2>
        <Badge size="sm" variant="info">
          {active} live
        </Badge>
      </div>
      <ul className="mt-3 flex gap-3 overflow-x-auto">
        {agents.map((agent) => (
          <li key={agent.id} className="flex w-16 shrink-0 flex-col items-center gap-1">
            <span
              className={`ops-avatar-mark grid size-10 place-items-center rounded-full text-xs font-semibold ${agent.mode === "active" ? "ops-live" : "ring-1 ring-inset ring-border"}`}
              style={{ background: agentColor(agent.name) }}
            >
              {agentMark(agent.name)}
            </span>
            <span className="w-full truncate text-center text-2xs">{agent.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ThroughputCard({ tasks }: { tasks: readonly OperationsTask[] }) {
  const series = touchSeries(tasks);
  const done = tasksInColumn(tasks, "Done").length;
  const max = Math.max(1, ...series);
  const width = 240;
  const height = 64;
  const line = series
    .map((value, index) => {
      const x = (index / Math.max(series.length - 1, 1)) * width;
      const y = height - (value / max) * (height - 8) - 4;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <section
      aria-labelledby="throughput-heading"
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-end justify-between gap-3">
        <h2 id="throughput-heading" className="text-sm font-semibold">
          Throughput
        </h2>
        <p className="text-2xl font-semibold tracking-tight">{done}</p>
      </div>
      <p className="text-2xs text-muted-foreground">Done today</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-16 w-full" role="img">
        <title>Tasks updated today, by hour</title>
        <path d={`${line} L${width} ${height} L0 ${height} Z`} fill="var(--info)" opacity="0.18" />
        <path d={line} fill="none" stroke="var(--info)" strokeWidth="2" />
      </svg>
    </section>
  );
}

function QaCard({ tasks }: { tasks: readonly OperationsTask[] }) {
  const counts = qaBreakdown(tasks);
  const parts = [
    { id: "accept", value: counts.accept, color: "var(--success)", label: "Accept" },
    { id: "rework", value: counts.rework, color: "var(--warning)", label: "Rework" },
    {
      id: "unavailable",
      value: counts.unavailable,
      color: "var(--destructive)",
      label: "Unavailable",
    },
    { id: "open", value: counts.open, color: "var(--muted-foreground)", label: "Open" },
  ];
  const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  let traveled = 0;
  const arcs = parts.flatMap((part) => {
    if (part.value === 0) return [];
    const length = (part.value / total) * circumference;
    const arc = { ...part, length, traveled };
    traveled += length;
    return [arc];
  });
  return (
    <section
      aria-labelledby="qa-chart-heading"
      className="rounded-xl border border-border bg-card p-4"
    >
      <h2 id="qa-chart-heading" className="text-sm font-semibold">
        QA
      </h2>
      <div className="mt-3 flex items-center gap-4">
        <svg viewBox="0 0 88 88" className="size-20 shrink-0" role="img">
          <title>QA verdicts</title>
          <circle cx="44" cy="44" r={radius} fill="none" stroke="var(--muted)" strokeWidth="9" />
          {arcs.map((arc) => (
            <circle
              key={arc.id}
              cx="44"
              cy="44"
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth="9"
              strokeDasharray={`${arc.length} ${circumference - arc.length}`}
              strokeDashoffset={-arc.traveled}
              transform="rotate(-90 44 44)"
            />
          ))}
          <text x="44" y="48" textAnchor="middle" className="fill-foreground text-sm font-semibold">
            {counts.accept}
          </text>
        </svg>
        <ul className="flex flex-col gap-1 text-2xs text-muted-foreground">
          {parts.map((part) => (
            <li key={part.id} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ background: part.color }}
              />
              <span>
                {part.label} {part.value}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function BlockerCard({
  items,
  noted,
  onAct,
}: {
  items: readonly NeedsYouItem[];
  noted: Readonly<Record<string, true>>;
  onAct: (id: string) => void;
}) {
  return (
    <section
      aria-labelledby="needs-you-heading"
      className="rounded-xl border border-border bg-card p-4"
    >
      <h2 id="needs-you-heading" className="text-sm font-semibold">
        Needs you
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Clear</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2" aria-live="polite">
              {item.kind === "blocker" ? (
                <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
              ) : (
                <CircleHelpIcon aria-hidden="true" className="size-4 shrink-0 text-info" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{item.nextAction}</span>
              {noted[item.id] ? (
                <Badge size="sm" variant="outline">
                  Noted
                </Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onAct(item.id)}>
                  {item.actionLabel}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskDrawer({
  task,
  live,
  onClose,
  onOpenRecord,
}: {
  task: OperationsTask | null;
  live: boolean;
  onClose: () => void;
  onOpenRecord: (factId: string) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useDialogCycle(task?.id ?? null, panelRef, titleRef, onClose);

  return (
    <>
      {task === null ? null : (
        <button
          type="button"
          aria-label="Close task details"
          onClick={onClose}
          className="absolute inset-0 z-20 bg-background/40"
        />
      )}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-drawer-title"
        aria-hidden={task === null}
        inert={task === null}
        data-state={task === null ? "closed" : "open"}
        className="ops-drawer absolute inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-l border-border bg-popover shadow-lg"
      >
        {task === null ? null : (
          <TaskDrawerBody
            task={task}
            live={live}
            titleRef={titleRef}
            onClose={onClose}
            onOpenRecord={onOpenRecord}
          />
        )}
      </aside>
    </>
  );
}

function TaskDrawerBody({
  task,
  live,
  titleRef,
  onClose,
  onOpenRecord,
}: {
  task: OperationsTask;
  live: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onOpenRecord: (factId: string) => void;
}) {
  const names = useProjectNames();
  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {projectLabel(task.projectId, names)} · {task.agent} · {task.surface}
          </p>
          <h2
            id="task-drawer-title"
            ref={titleRef}
            tabIndex={-1}
            className="mt-1 text-lg font-semibold tracking-tight outline-none"
          >
            {task.title}
          </h2>
          <div className="mt-2">
            <Badge variant={qaBadgeTone(task)}>
              {qaStatusLabel(task)} · {findingsCount(task)}
            </Badge>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="flex flex-col gap-5">
          <section aria-labelledby="progress-heading">
            <h3 id="progress-heading" className="text-sm font-semibold">
              Progress
            </h3>
            <ProgressStepper phase={task.phase} />
          </section>
          <section aria-labelledby="context-heading">
            <h3 id="context-heading" className="text-sm font-semibold">
              Context
            </h3>
            <ContextPackageView task={task} onOpenRecord={onOpenRecord} />
          </section>
          <section aria-labelledby="request-heading">
            <h3 id="request-heading" className="text-sm font-semibold">
              Request
            </h3>
            <p className="mt-2 text-sm leading-6">{task.intake.request}</p>
          </section>
          <section aria-labelledby="criteria-heading">
            <h3 id="criteria-heading" className="text-sm font-semibold">
              Acceptance criteria
            </h3>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm leading-6">
              {task.intake.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="suggestions-heading">
            <h3 id="suggestions-heading" className="text-sm font-semibold">
              Suggestions, not context
            </h3>
            {task.candidates.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">None</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {task.candidates.map((candidate) => (
                  <li key={candidate.nodeId}>
                    <span className="inline-flex rounded-full border border-dashed border-border px-2.5 py-1 font-mono text-2xs text-muted-foreground">
                      {candidate.score.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="evidence-heading">
            <h3 id="evidence-heading" className="text-sm font-semibold">
              Evidence
            </h3>
            {task.completion === null ? (
              <p className="mt-2 text-sm text-muted-foreground">No evidence submitted yet.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {task.completion.evidence.map((item) => (
                  <li key={`${item.kind}:${item.ref}`}>
                    <span className="text-muted-foreground">{item.kind}</span> {item.ref}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {task.reworkCap == null ? null : (
            <section aria-labelledby="rework-cap-heading">
              <h3 id="rework-cap-heading" className="text-sm font-semibold">
                {task.reworkCap.label}
              </h3>
              <p className="mt-2 text-sm leading-6">{task.reworkCap.recommendation}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {task.reworkCap.remainingIssue.map((finding) => (
                  <li key={finding.defect} className="text-sm">
                    {finding.defect}
                  </li>
                ))}
              </ul>
              <ol className="mt-3 flex flex-col gap-2">
                {task.reworkCap.attemptedFixes.map((round) => (
                  <li key={round.round} className="text-sm">
                    <span className="text-muted-foreground">Round {round.round}</span>{" "}
                    {round.summary}
                    {round.commitSha === null ? null : (
                      <span className="mt-1 block font-mono text-xs text-muted-foreground">
                        {round.commitSha.slice(0, 7)}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <AdvisoryReviewSection task={task} live={live} />
          <section aria-labelledby="qa-heading">
            <h3 id="qa-heading" className="text-sm font-semibold">
              QA
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={qaBadgeTone(task)}>
                {qaStatusLabel(task)} · {findingsCount(task)} findings
              </Badge>
            </div>
            {task.qa !== null &&
            task.qa.availability === "available" &&
            task.qa.findings.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {task.qa.findings.map((finding) => (
                  <li key={finding.defect} className="text-sm">
                    {finding.defect}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <section aria-labelledby="artifacts-heading">
            <h3 id="artifacts-heading" className="text-sm font-semibold">
              Artifacts
            </h3>
            <p className="mt-2 font-mono text-sm">{shortRevision(task)}</p>
            {task.completion === null ? null : (
              <p className="mt-1 text-sm text-muted-foreground">{task.completion.claimedOutcome}</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

const STEP_DOT = {
  pending: "size-2.5 rounded-full bg-muted",
  current: "size-2.5 rounded-full bg-info",
  stalled: "size-2.5 rounded-full bg-warning",
  done: "size-2.5 rounded-full bg-info",
  accepted: "size-2.5 rounded-full bg-success",
} as const;

function ProgressStepper({ phase }: { phase: OperationsTask["phase"] }) {
  const state = progressIndex(phase);
  return (
    <ol className="mt-3 grid grid-cols-6 gap-1">
      {PROGRESS_STEPS.map((step, index) => {
        const reached = index <= state.index;
        const current = index === state.index;
        const tone = !reached
          ? "pending"
          : current && state.stalled
            ? "stalled"
            : index === PROGRESS_STEPS.length - 1
              ? "accepted"
              : current
                ? "current"
                : "done";
        return (
          <li
            key={step.id}
            className="flex min-w-0 flex-col items-center gap-1"
            aria-current={current ? "step" : undefined}
          >
            <span aria-hidden="true" className={STEP_DOT[tone]} />
            <span
              className={
                reached
                  ? "text-center text-2xs leading-4"
                  : "text-center text-2xs leading-4 text-muted-foreground"
              }
            >
              {step.label}
            </span>
            {current && state.stalled ? (
              <Badge size="sm" variant="warning">
                {phase === "rework_capped" ? "Needs Jim" : "Unknown"}
              </Badge>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
