import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useEffect, useRef, useState, type RefObject } from "react";

import { ContextPackageView } from "./ContextPackageView";
import { CortexView } from "./CortexView";
import { MemoryBrowser } from "./MemoryBrowser";
import type { OperationsProjectId } from "./fixtures";
import { INITIAL_MEMORY_REVIEW, type MemoryReviewState } from "./memoryModel";
import {
  BOARD_COLUMNS,
  activeAgentCount,
  formatInstant,
  formatShare,
  formatUsdMinor,
  needsYou,
  projectById,
  projects,
  qaBadgeTone,
  qaStatusLabel,
  recentResults,
  shortRevision,
  tasksForProject,
  tasksInColumn,
  usageFor,
  type QaBadgeTone,
} from "./model";
import type { NeedsYouItem, OperationsTask } from "./fixtures";

const TONE_DOT: Record<QaBadgeTone | "muted", string> = {
  secondary: "bg-muted-foreground",
  info: "bg-info",
  warning: "bg-warning",
  success: "bg-success",
  muted: "bg-muted-foreground",
};

const COLUMN_ACCENT: Record<(typeof BOARD_COLUMNS)[number]["id"], string> = {
  Ready: "border-l-info",
  Running: "border-l-info",
  Blocked: "border-l-warning",
  Review: "border-l-warning",
  Done: "border-l-success",
};

export function OperationsDashboard() {
  const [projectId, setProjectId] = useState<OperationsProjectId>("usba");
  const [surface, setSurface] = useState<"board" | "memory">("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [noted, setNoted] = useState<Readonly<Record<string, true>>>({});
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryId, setMemoryId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>("fact-friday-7");
  const [review, setReview] = useState<MemoryReviewState>(INITIAL_MEMORY_REVIEW);
  const [memoryNotes, setMemoryNotes] = useState<Readonly<Record<string, string>>>({});
  const project = projectById(projectId);
  const tasks = tasksForProject(projectId);
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
  const results = recentResults(tasks);
  const usage = usageFor(tasks);
  const active = activeAgentCount(project.agents);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground">
              {project.detail}
            </p>
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
            <ProjectPicker projectId={projectId} onChange={setProjectId} />
            <Button size="sm" variant="outline" onClick={() => openMemory(null)}>
              Browse memory
            </Button>
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {surface === "memory" ? (
          <div className="p-4 sm:p-6">
            <CortexView
              projectId={projectId}
              projectLabel={project.label}
              review={review}
              highlightId={highlightId}
              currentTaskId={currentTaskId}
              onOpenRecord={openMemory}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4 sm:p-6">
            <AgentStrip
              active={active}
              agents={project.agents}
              open={agentsOpen}
              onToggle={() => setAgentsOpen((open) => !open)}
            />
            <section aria-labelledby="board-heading">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 id="board-heading" className="text-sm font-semibold tracking-tight">
                  Board
                </h2>
                <p className="text-xs text-muted-foreground">{project.label}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
                {BOARD_COLUMNS.map((column) => (
                  <section
                    key={column.id}
                    aria-labelledby={`column-${column.id}`}
                    className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card/40 p-2"
                  >
                    <div className="px-1.5 pt-1">
                      <h3 id={`column-${column.id}`} className="text-sm font-medium">
                        {column.label}
                      </h3>
                      <p className="text-2xs leading-4 text-muted-foreground">{column.hint}</p>
                    </div>
                    <div className="flex flex-col gap-2">
                      {tasksInColumn(tasks, column.id).map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          accent={COLUMN_ACCENT[column.id]}
                          pressed={task.id === selected?.id}
                          onOpen={() => {
                            setCurrentTaskId(task.id);
                            setSelectedId(task.id);
                          }}
                        />
                      ))}
                      {tasksInColumn(tasks, column.id).length === 0 ? (
                        <p className="px-1.5 py-3 text-xs text-muted-foreground">Nothing here</p>
                      ) : null}
                    </div>
                  </section>
                ))}
              </div>
            </section>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <NeedsYouPanel
                items={attention}
                noted={noted}
                onAct={(id) => setNoted((current) => ({ ...current, [id]: true }))}
              />
              <RecentResultsPanel
                results={results}
                onOpen={(id) => {
                  setCurrentTaskId(id);
                  setSelectedId(id);
                }}
              />
              <UsagePanel
                tokens={usage.totals.reportedTokens}
                costMinor={usage.totals.estimatedCostMinorUsd}
                shareBps={usage.totals.subscriptionAllocationBps}
                unknown={usage.totals.unknownCount}
              />
            </div>
          </div>
        )}
      </main>
      <TaskDrawer
        task={selected}
        onClose={() => setSelectedId(null)}
        onOpenRecord={(factId) => {
          if (selected !== null) setCurrentTaskId(selected.id);
          openMemory(factId);
        }}
      />
      <MemoryBrowser
        open={memoryOpen}
        projectId={projectId}
        projectLabel={project.label}
        currentTaskId={currentTaskId}
        currentTaskTitle={currentTask?.title ?? null}
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
  projectId,
  onChange,
}: {
  projectId: OperationsProjectId;
  onChange: (id: OperationsProjectId) => void;
}) {
  return (
    <div aria-label="Workspace" className="flex flex-wrap gap-2" role="group">
      {projects().map((project) => {
        const selected = project.id === projectId;
        return (
          <Button
            key={project.id}
            aria-pressed={selected}
            size="sm"
            variant={selected ? "secondary" : "outline"}
            onClick={() => onChange(project.id)}
          >
            {project.label}
          </Button>
        );
      })}
    </div>
  );
}

function AgentStrip({
  active,
  agents,
  open,
  onToggle,
}: {
  active: number;
  agents: ReturnType<typeof projectById>["agents"];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section
      aria-labelledby="agents-heading"
      className="rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="agents-heading" className="text-sm font-semibold tracking-tight">
            Agent activity
          </h2>
          <p className="text-xs text-muted-foreground">
            {active} active {active === 1 ? "assignment" : "assignments"}
          </p>
        </div>
        <Button
          aria-expanded={open}
          aria-controls="agent-assignments"
          size="sm"
          variant="outline"
          onClick={onToggle}
        >
          {open ? "Hide assignments" : "Show assignments"}
        </Button>
      </div>
      {open ? (
        <ul id="agent-assignments" className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border/80 bg-background/50 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{agent.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {agent.surface} · {agent.assignment}
                </p>
              </div>
              <Badge variant={agent.mode === "active" ? "info" : "outline"} size="sm">
                {agent.mode === "active" ? "Active" : "Update only"}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TaskCard({
  task,
  accent,
  pressed,
  onOpen,
}: {
  task: OperationsTask;
  accent: string;
  pressed: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onOpen}
      className={`rounded-lg border border-border border-l-2 bg-card px-3 py-2.5 text-left shadow-xs transition-colors duration-150 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none ${accent} ${pressed ? "bg-accent/50" : ""}`}
    >
      <span className="line-clamp-2 text-sm font-medium">{task.title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">
        {projectLabel(task.projectId)} · {task.agent}
      </span>
      <span className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={qaBadgeTone(task)} size="sm">
          {qaStatusLabel(task)}
        </Badge>
      </span>
      <span className="mt-2 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span className="font-mono">{shortRevision(task)}</span>
        <span>{formatInstant(task.updatedAt)}</span>
      </span>
    </button>
  );
}

function NeedsYouPanel({
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
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div>
        <h2 id="needs-you-heading" className="text-sm font-semibold tracking-tight">
          Needs you
        </h2>
        <p className="text-xs text-muted-foreground">Blockers and decisions</p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-border/80 bg-background/40 p-3">
              <div className="flex items-center gap-2">
                <Badge variant={item.kind === "blocker" ? "warning" : "info"} size="sm">
                  {item.kind === "blocker" ? "Blocker" : "Decision"}
                </Badge>
              </div>
              <h3 className="mt-2 text-sm font-medium">{item.summary}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{item.nextAction}</p>
              <div className="mt-3" aria-live="polite">
                {noted[item.id] ? (
                  <p className="text-xs text-muted-foreground">
                    Noted. This mockup does not send the action.
                  </p>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onAct(item.id)}>
                    {item.actionLabel}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentResultsPanel({
  results,
  onOpen,
}: {
  results: readonly { readonly task: OperationsTask; readonly summary: string }[];
  onOpen: (id: string) => void;
}) {
  return (
    <section
      aria-labelledby="results-heading"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div>
        <h2 id="results-heading" className="text-sm font-semibold tracking-tight">
          Recent results
        </h2>
        <p className="text-xs text-muted-foreground">Accepted work in this workspace</p>
      </div>
      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accepted results yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map(({ task, summary }) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpen(task.id)}
                className="w-full rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-left transition-colors duration-150 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              >
                <h3 className="text-sm font-medium">{task.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{summary}</p>
                <p className="mt-1 font-mono text-2xs text-muted-foreground">
                  {shortRevision(task)} · {formatInstant(task.updatedAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UsagePanel({
  tokens,
  costMinor,
  shareBps,
  unknown,
}: {
  tokens: { readonly input: number; readonly output: number };
  costMinor: number;
  shareBps: number;
  unknown: number;
}) {
  return (
    <section
      aria-labelledby="usage-heading"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div>
        <h2 id="usage-heading" className="text-sm font-semibold tracking-tight">
          Usage
        </h2>
        <p className="text-xs text-muted-foreground">Each kind stays in its own total</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <UsageKind
          tone="info"
          label="Reported tokens"
          value={`${tokens.input.toLocaleString("en-US")} in`}
          note={`${tokens.output.toLocaleString("en-US")} out · reported by the client`}
        />
        <UsageKind
          tone="warning"
          label="Estimated cost"
          value={formatUsdMinor(costMinor)}
          note="Estimate only. Not a charge."
        />
        <UsageKind
          tone="success"
          label="Subscription"
          value={formatShare(shareBps)}
          note="Share of a subscription. Not dollars."
        />
        <UsageKind
          tone="muted"
          label="Unknown"
          value={String(unknown)}
          note={unknown === 1 ? "Session with no report" : "Sessions with no report"}
        />
      </div>
    </section>
  );
}

function UsageKind({
  tone,
  label,
  value,
  note,
}: {
  tone: "info" | "warning" | "success" | "muted";
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-border/80 bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-1.5 rounded-full ${TONE_DOT[tone]}`} />
        <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      </div>
      <p className="mt-2 text-lg font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function TaskDrawer({
  task,
  onClose,
  onOpenRecord,
}: {
  task: OperationsTask | null;
  onClose: () => void;
  onOpenRecord: (factId: string) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (task === null) return;
    titleRef.current?.focus();
  }, [task]);

  useEffect(() => {
    if (task === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, a, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [task, onClose]);

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
        className={`absolute inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-l border-border bg-popover shadow-lg transition-transform duration-200 ease-out ${task === null ? "translate-x-full" : "translate-x-0"}`}
      >
        {task === null ? null : (
          <TaskDrawerBody
            task={task}
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
  titleRef,
  onClose,
  onOpenRecord,
}: {
  task: OperationsTask;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onOpenRecord: (factId: string) => void;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {projectLabel(task.projectId)} · {task.agent} · {task.surface}
          </p>
          <h2
            id="task-drawer-title"
            ref={titleRef}
            tabIndex={-1}
            className="mt-1 text-lg font-semibold tracking-tight outline-none"
          >
            {task.title}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="flex flex-col gap-5">
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
          <section aria-labelledby="context-heading">
            <h3 id="context-heading" className="text-sm font-semibold">
              Context
            </h3>
            <ContextPackageView task={task} onOpenRecord={onOpenRecord} />
          </section>
          <section aria-labelledby="suggestions-heading">
            <h3 id="suggestions-heading" className="text-sm font-semibold">
              Suggestions, not context
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Vector candidates. They are not in the context package.
            </p>
            {task.candidates.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No suggestions.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {task.candidates.map((candidate) => (
                  <li
                    key={candidate.nodeId}
                    className="rounded-lg border border-dashed border-border px-3 py-2"
                  >
                    <p className="font-mono text-2xs text-muted-foreground">
                      {candidate.nodeId} · {candidate.source} · {candidate.score.toFixed(2)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="progress-heading">
            <h3 id="progress-heading" className="text-sm font-semibold">
              Progress
            </h3>
            {task.progress.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No progress reports.</p>
            ) : (
              <ol className="mt-2 flex flex-col gap-2">
                {task.progress.map((report) => (
                  <li
                    key={`${report.attemptId}-${report.generation}`}
                    className="rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm"
                  >
                    <p className="font-medium">
                      {report.status === "working" ? "Working" : "Blocked"} · generation{" "}
                      {report.generation}
                    </p>
                    {report.blockers.map((blocker) => (
                      <p key={blocker.summary} className="mt-1 text-xs text-muted-foreground">
                        {blocker.summary} Next: {blocker.nextAction}
                      </p>
                    ))}
                    {report.partialArtifacts.map((artifact) => (
                      <p key={artifact.artifactId} className="mt-1 text-xs text-muted-foreground">
                        {artifact.note}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
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
          <section aria-labelledby="qa-heading">
            <h3 id="qa-heading" className="text-sm font-semibold">
              QA
            </h3>
            <div className="mt-2">
              <Badge variant={qaBadgeTone(task)}>{qaStatusLabel(task)}</Badge>
            </div>
            {task.qa !== null &&
            task.qa.availability === "available" &&
            task.qa.findings.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-2">
                {task.qa.findings.map((finding) => (
                  <li
                    key={finding.defect}
                    className="rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm"
                  >
                    <p className="font-medium">{finding.defect}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{finding.evidence}</p>
                    <p className="mt-1 text-xs">Expected: {finding.expectedBehavior}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No findings.</p>
            )}
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

function projectLabel(id: OperationsProjectId): string {
  return projectById(id).label;
}
