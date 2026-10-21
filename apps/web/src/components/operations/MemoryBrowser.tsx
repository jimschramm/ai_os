import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useRef, useState } from "react";

import {
  MEMORY_SCOPE_FILTERS,
  MEMORY_STATUS_FILTERS,
  MEMORY_TYPE_FILTERS,
  authorLabel,
  filterRows,
  formatProvenance,
  freshness,
  factById,
  linkedEvidence,
  memoryRows,
  openConflicts,
  versionChain,
  type MemoryReviewState,
  type MemoryRow,
  type MemoryScope,
  type MemoryStatus,
  type MemoryTypeFilter,
} from "./memoryModel";
import { useDialogCycle } from "./dialogFocus";

const STATUS_BADGE = {
  proposed: "info",
  accepted: "success",
  superseded: "secondary",
  rejected: "error",
  conflicting: "warning",
} as const;

export function MemoryBrowser({
  open,
  projectId,
  projectLabel,
  currentTaskId,
  currentTaskTitle,
  review,
  selectedId,
  notes,
  onSelect,
  onClose,
  onShowRelationships,
  onReject,
  onResolve,
  onCorrect,
}: {
  open: boolean;
  projectId: string;
  projectLabel: string;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  review: MemoryReviewState;
  selectedId: string | null;
  notes: Readonly<Record<string, string>>;
  onSelect: (factId: string | null) => void;
  onClose: () => void;
  onShowRelationships: (factId: string | null) => void;
  onReject: (factId: string) => void;
  onResolve: (conflictId: string, keptId: string | null) => void;
  onCorrect: (factId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [type, setType] = useState<MemoryTypeFilter | "all">("all");
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useDialogCycle(open ? "memory" : null, panelRef, titleRef, onClose);
  const rows = filterRows(memoryRows(projectId, review), {
    query,
    scope,
    type,
    status,
    currentTaskId,
  });
  const conflicts = openConflicts(projectId, review);
  const selected = rows.find((row) => row.fact.factId === selectedId) ?? null;

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close memory"
          onClick={onClose}
          className="absolute inset-0 z-30 bg-background/40"
        />
      ) : null}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-browser-title"
        aria-hidden={!open}
        inert={!open}
        className={`ops-drawer absolute inset-y-0 right-0 z-40 flex w-full max-w-3xl flex-col border-l border-border bg-popover shadow-lg transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
          <div>
            <p className="text-xs text-muted-foreground">{projectLabel}</p>
            <h2
              id="memory-browser-title"
              ref={titleRef}
              tabIndex={-1}
              className="mt-1 text-lg font-semibold tracking-tight outline-none"
            >
              Memory
            </h2>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => onShowRelationships(selectedId)}>
              Show relationships
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
          <div className="min-h-0 overflow-auto border-b border-border px-4 py-4 lg:border-e lg:border-b-0">
            <label className="block">
              <span className="sr-only">Search memory</span>
              <Input
                type="search"
                size="sm"
                placeholder="Search memory"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div className="mt-3 flex flex-col gap-3">
              <ChoiceRow
                label="Scope"
                value={scope}
                options={[{ id: "all", label: "Any scope" }, ...MEMORY_SCOPE_FILTERS]}
                onChange={(id) => setScope(id as MemoryScope | "all")}
              />
              <ChoiceRow
                label="Type"
                value={type}
                options={[{ id: "all", label: "Any type" }, ...MEMORY_TYPE_FILTERS]}
                onChange={(id) => setType(id as MemoryTypeFilter | "all")}
              />
              <ChoiceRow
                label="Status"
                value={status}
                options={[{ id: "all", label: "Any status" }, ...MEMORY_STATUS_FILTERS]}
                onChange={(id) => setStatus(id as MemoryStatus | "all")}
              />
            </div>
            {scope === "task" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {currentTaskTitle === null
                  ? "Open a task on the board to use this scope."
                  : `Current task: ${currentTaskTitle}`}
              </p>
            ) : null}
            <section aria-labelledby="conflicts-heading" className="mt-4">
              <h3 id="conflicts-heading" className="text-sm font-semibold">
                Conflicts
              </h3>
              {conflicts.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No open conflicts.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {conflicts.map((conflict) => (
                    <li
                      key={conflict.id}
                      className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2"
                    >
                      <p className="text-sm">{conflict.summary}</p>
                      <ul className="mt-2 flex flex-col gap-2">
                        {conflict.factIds.map((factId) => (
                          <li key={factId} className="rounded-md bg-background/50 px-2 py-2">
                            <p className="text-sm">{factById(factId)?.body ?? factId}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onResolve(conflict.id, factId)}
                              >
                                Accept
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => onReject(factId)}>
                                Reject
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onResolve(conflict.id, null)}
                        >
                          Resolve
                        </Button>
                      </div>
                      {notes[conflict.id] !== undefined ? (
                        <p className="mt-2 text-xs text-muted-foreground">{notes[conflict.id]}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="memory-results-heading" className="mt-4">
              <h3 id="memory-results-heading" className="text-sm font-semibold">
                Records
              </h3>
              {rows.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No records match.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {rows.map((row) => (
                    <li key={row.fact.factId}>
                      <button
                        type="button"
                        aria-pressed={row.fact.factId === selectedId}
                        onClick={() => onSelect(row.fact.factId)}
                        className="w-full rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-left transition-colors duration-150 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={row.status} />
                          <span className="text-2xs text-muted-foreground">{row.fact.kind}</span>
                        </span>
                        <span className="mt-1 block text-sm">{row.fact.body}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {authorLabel(row.fact.provenance.actorId)} · {freshness(row.fact)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div className="min-h-0 overflow-auto px-4 py-4">
            {selected === null ? (
              <p className="text-sm text-muted-foreground">Select a record to read it.</p>
            ) : (
              <RecordDetail
                row={selected}
                note={notes[selected.fact.factId] ?? null}
                corrected={review.corrections.has(selected.fact.factId)}
                onReject={() => onReject(selected.fact.factId)}
                onCorrect={() => onCorrect(selected.fact.factId)}
                onShowRelationships={() => onShowRelationships(selected.fact.factId)}
              />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function RecordDetail({
  row,
  note,
  corrected,
  onReject,
  onCorrect,
  onShowRelationships,
}: {
  row: MemoryRow;
  note: string | null;
  corrected: boolean;
  onReject: () => void;
  onCorrect: () => void;
  onShowRelationships: () => void;
}) {
  const chain = versionChain(row.fact.factId);
  const evidence = linkedEvidence(row.fact.factId);
  return (
    <article aria-labelledby="memory-record-title" className="flex flex-col gap-4">
      <div>
        <StatusBadge status={row.status} />
        <h3 id="memory-record-title" className="mt-2 text-base font-semibold">
          {row.fact.body}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {authorLabel(row.fact.provenance.actorId)} · {freshness(row.fact)} · {row.meta.scope}
        </p>
      </div>
      <section aria-labelledby="record-provenance-heading">
        <h4 id="record-provenance-heading" className="text-xs font-medium text-muted-foreground">
          Provenance
        </h4>
        <p className="mt-1 text-sm">{formatProvenance(row.fact)}</p>
        {row.fact.acceptance !== "proposed" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Accepted by {authorLabel(row.fact.acceptedBy)}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="record-sources-heading">
        <h4 id="record-sources-heading" className="text-xs font-medium text-muted-foreground">
          Sources
        </h4>
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-sm">
          {row.meta.sources.map((source) => (
            <li key={source}>{source}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="record-evidence-heading">
        <h4 id="record-evidence-heading" className="text-xs font-medium text-muted-foreground">
          Supporting evidence
        </h4>
        {evidence.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">No evidence linked.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {evidence.map((item) => (
              <li key={`${item.label}:${item.detail}`}>
                <span className="text-muted-foreground">{item.label}.</span> {item.detail}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="record-history-heading">
        <h4 id="record-history-heading" className="text-xs font-medium text-muted-foreground">
          Version history
        </h4>
        <ol className="mt-2 flex flex-col gap-2">
          {chain.map((fact, index) => (
            <li key={fact.factId} className="rounded-lg border border-border/80 px-3 py-2">
              <p className="text-sm">{fact.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {fact.acceptance}
                {index < chain.length - 1 ? " · supersedes the next version" : ""}
              </p>
            </li>
          ))}
        </ol>
      </section>
      <div className="flex flex-wrap gap-2" aria-live="polite">
        {row.fact.acceptance === "proposed" && row.status !== "rejected" ? (
          <Button size="sm" variant="outline" onClick={onReject}>
            Reject
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={onCorrect}>
          Correct record
        </Button>
        <Button size="sm" variant="ghost" onClick={onShowRelationships}>
          Show relationships
        </Button>
      </div>
      {corrected ? (
        <p className="text-xs text-muted-foreground">
          Correction noted. This mockup does not save it.
        </p>
      ) : null}
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </article>
  );
}

function StatusBadge({ status }: { status: MemoryStatus }) {
  const label = status.slice(0, 1).toUpperCase() + status.slice(1);
  return (
    <Badge size="sm" variant={STATUS_BADGE[status]}>
      {label}
    </Badge>
  );
}

function ChoiceRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { readonly id: string; readonly label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span className="me-1 text-xs text-muted-foreground" aria-hidden="true">
        {label}
      </span>
      {options.map((option) => (
        <Button
          key={option.id}
          aria-pressed={option.id === value}
          size="sm"
          variant={option.id === value ? "secondary" : "outline"}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}
