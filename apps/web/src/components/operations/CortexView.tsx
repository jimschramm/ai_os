import { Button } from "~/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";

import {
  CORTEX_CENTER,
  CORTEX_RING_RADIUS,
  MEMORY_SCOPE_FILTERS,
  MEMORY_STATUS_FILTERS,
  arcPath,
  authorLabel,
  layoutCortex,
  type CortexNode,
  type MemoryReviewState,
  type MemoryScope,
  type MemoryStatus,
} from "./memoryModel";

const STATUS_FILL: Record<MemoryStatus, string> = {
  accepted: "fill-success",
  proposed: "fill-info",
  superseded: "fill-muted-foreground",
  rejected: "fill-destructive",
  conflicting: "fill-warning",
};

export function CortexView({
  projectId,
  projectLabel,
  review,
  highlightId,
  currentTaskId,
  onOpenRecord,
}: {
  projectId: string;
  projectLabel: string;
  review: MemoryReviewState;
  highlightId: string | null;
  currentTaskId: string | null;
  onOpenRecord: (factId: string) => void;
}) {
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [focus, setFocus] = useState<{ source: string | null; id: string | null }>({
    source: highlightId,
    id: highlightId,
  });
  const focusedId = focus.source === highlightId ? focus.id : highlightId;
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const glowId = useId().replace(/:/g, "");
  const layout = layoutCortex(projectId, review, { scope, status, currentTaskId });
  const focused =
    layout.nodes.find((node) => node.fact.factId === (focusedId ?? highlightId)) ??
    layout.nodes.find((node) => node.conflicting) ??
    null;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = event.deltaY > 0 ? -0.08 : 0.08;
      setTransform((current) => ({
        ...current,
        scale: clamp(current.scale + next, 0.7, 2.2),
      }));
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, []);

  const zoom = (delta: number) => {
    setTransform((current) => ({ ...current, scale: clamp(current.scale + delta, 0.7, 2.2) }));
  };

  return (
    <section aria-labelledby="cortex-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="cortex-heading" className="text-sm font-semibold tracking-tight">
            Cortex
          </h2>
          <p className="text-xs text-muted-foreground">
            {projectLabel} memory. Arcs run from the newer record to the one it replaced.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => zoom(0.15)}>
            Zoom in
          </Button>
          <Button size="sm" variant="outline" onClick={() => zoom(-0.15)}>
            Zoom out
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
            Reset view
          </Button>
        </div>
      </div>
      <FilterRow
        label="Scope"
        value={scope}
        options={[{ id: "all", label: "All scopes" }, ...MEMORY_SCOPE_FILTERS]}
        onChange={(id) => setScope(id as MemoryScope | "all")}
      />
      <FilterRow
        label="Status"
        value={status}
        options={[{ id: "all", label: "All statuses" }, ...MEMORY_STATUS_FILTERS]}
        onChange={(id) => setStatus(id as MemoryStatus | "all")}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div
          ref={surfaceRef}
          className="relative overflow-hidden rounded-2xl border border-border bg-card"
          onPointerDown={(event) => {
            if ((event.target as Element).closest("[data-memory-node]")) return;
            dragRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              originX: transform.x,
              originY: transform.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId) return;
            setTransform((current) => ({
              ...current,
              x: drag.originX + event.clientX - drag.x,
              y: drag.originY + event.clientY - drag.y,
            }));
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") zoom(0.15);
            if (event.key === "-" || event.key === "_") zoom(-0.15);
            if (event.key === "0") setTransform({ x: 0, y: 0, scale: 1 });
            if (event.key === "ArrowLeft")
              setTransform((current) => ({ ...current, x: current.x + 24 }));
            if (event.key === "ArrowRight")
              setTransform((current) => ({ ...current, x: current.x - 24 }));
            if (event.key === "ArrowUp")
              setTransform((current) => ({ ...current, y: current.y + 24 }));
            if (event.key === "ArrowDown")
              setTransform((current) => ({ ...current, y: current.y - 24 }));
          }}
          tabIndex={0}
          aria-label="Memory graph. Use the arrow keys to pan and plus or minus to zoom."
        >
          <svg viewBox="0 0 720 720" className="h-auto w-full touch-none" role="img">
            <title>{`${projectLabel} memory graph, ${layout.conflictCount} open ${layout.conflictCount === 1 ? "conflict" : "conflicts"}`}</title>
            <defs>
              <radialGradient id={`${glowId}-wash`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="var(--color-warning)" stopOpacity="0.16" />
                <stop offset="55%" stopColor="var(--color-background)" stopOpacity="0" />
              </radialGradient>
              <filter id={`${glowId}-glow`} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <marker
                id={`${glowId}-arrow`}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="3"
                orient="auto"
              >
                <path d="M 0 0 L 8 3 L 0 6 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            <g
              transform={`translate(${CORTEX_CENTER.x + transform.x} ${CORTEX_CENTER.y + transform.y}) scale(${transform.scale}) translate(${-CORTEX_CENTER.x} ${-CORTEX_CENTER.y})`}
            >
              <circle
                cx={CORTEX_CENTER.x}
                cy={CORTEX_CENTER.y}
                r="300"
                fill={`url(#${glowId}-wash)`}
              />
              {(["inner", "mid", "outer"] as const).map((ring) => (
                <circle
                  key={ring}
                  cx={CORTEX_CENTER.x}
                  cy={CORTEX_CENTER.y}
                  r={CORTEX_RING_RADIUS[ring]}
                  fill="none"
                  className="stroke-border"
                />
              ))}
              <RingLabel
                y={CORTEX_CENTER.y - CORTEX_RING_RADIUS.inner - 14}
                text="Instructions and decisions"
              />
              <RingLabel
                y={CORTEX_CENTER.y - CORTEX_RING_RADIUS.mid - 14}
                text="Facts and working knowledge"
              />
              <RingLabel
                y={CORTEX_CENTER.y - CORTEX_RING_RADIUS.outer - 14}
                text="Tasks, attempts, artifacts"
              />
              {layout.arcs.map((arc) => (
                <path
                  key={`${arc.fromId}-${arc.toId}`}
                  d={arcPath(arc.from, arc.to)}
                  fill="none"
                  className="stroke-muted-foreground"
                  strokeWidth="1.25"
                  markerEnd={`url(#${glowId}-arrow)`}
                />
              ))}
              <g>
                <circle
                  cx={CORTEX_CENTER.x}
                  cy={CORTEX_CENTER.y}
                  r="46"
                  className="fill-background stroke-border"
                />
                <text
                  x={CORTEX_CENTER.x}
                  y={CORTEX_CENTER.y - 4}
                  textAnchor="middle"
                  className="fill-foreground text-sm font-medium"
                >
                  {projectLabel}
                </text>
                <text
                  x={CORTEX_CENTER.x}
                  y={CORTEX_CENTER.y + 16}
                  textAnchor="middle"
                  className="fill-warning text-2xs"
                >
                  {layout.conflictCount} {layout.conflictCount === 1 ? "conflict" : "conflicts"}
                </text>
              </g>
              {layout.nodes.map((node) => (
                <CortexNodeShape
                  key={node.fact.factId}
                  node={node}
                  glow={`url(#${glowId}-glow)`}
                  selected={node.fact.factId === focused?.fact.factId}
                  onOpen={() => {
                    setFocus({ source: highlightId, id: node.fact.factId });
                    onOpenRecord(node.fact.factId);
                  }}
                  onFocus={() => setFocus({ source: highlightId, id: node.fact.factId })}
                />
              ))}
            </g>
          </svg>
        </div>
        <div className="flex flex-col gap-3">
          <section
            aria-live="polite"
            aria-labelledby="cortex-summary-heading"
            className="rounded-xl border border-border bg-card p-4"
          >
            <h3 id="cortex-summary-heading" className="text-sm font-semibold">
              {focused === null ? "Nothing in this view" : focused.fact.body}
            </h3>
            {focused === null ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Change the filters to bring records back.
              </p>
            ) : (
              <>
                <p className="mt-2 text-xs text-muted-foreground">
                  {focused.fact.kind} · {authorLabel(focused.fact.provenance.actorId)} ·{" "}
                  {focused.status}
                </p>
                {focused.conflicting ? (
                  <p className="mt-2 text-sm text-warning-foreground">
                    Competing claim. The glow marks both sides.
                  </p>
                ) : null}
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenRecord(focused.fact.factId)}
                  >
                    Open record
                  </Button>
                </div>
              </>
            )}
          </section>
          <section
            aria-labelledby="cortex-list-heading"
            className="rounded-xl border border-border bg-card p-3"
          >
            <h3 id="cortex-list-heading" className="px-1 text-sm font-semibold">
              Records
            </h3>
            <ul className="mt-2 flex max-h-80 flex-col gap-1 overflow-auto">
              {layout.nodes.map((node) => (
                <li key={node.fact.factId}>
                  <button
                    type="button"
                    onClick={() => {
                      setFocus({ source: highlightId, id: node.fact.factId });
                      onOpenRecord(node.fact.factId);
                    }}
                    className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className={node.dimmed ? "text-muted-foreground" : undefined}>
                      {node.fact.body}
                    </span>
                    <span className="mt-0.5 block text-2xs text-muted-foreground">
                      {node.status}
                      {node.conflicting ? " · competing" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}

function CortexNodeShape({
  node,
  glow,
  selected,
  onOpen,
  onFocus,
}: {
  node: CortexNode;
  glow: string;
  selected: boolean;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const label = node.fact.body.length > 28 ? `${node.fact.body.slice(0, 28)}…` : node.fact.body;
  const dx = node.x - CORTEX_CENTER.x;
  const anchor = dx > 24 ? "start" : dx < -24 ? "end" : "middle";
  const textX = anchor === "start" ? 14 : anchor === "end" ? -14 : 0;
  return (
    <g
      data-memory-node=""
      role="button"
      tabIndex={0}
      transform={`translate(${node.x} ${node.y})`}
      className={node.dimmed ? "opacity-45" : undefined}
      aria-label={`${node.fact.body}. ${node.status}.`}
      onClick={onOpen}
      onFocus={onFocus}
      onMouseEnter={onFocus}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {node.conflicting ? <circle r="16" className="fill-warning/40" filter={glow} /> : null}
      <circle
        r="7"
        className={`${STATUS_FILL[node.status]} ${selected ? "stroke-foreground" : ""}`}
        strokeWidth="2"
      />
      <text x={textX} y="22" textAnchor={anchor} className="fill-muted-foreground text-2xs">
        {label}
      </text>
    </g>
  );
}

function RingLabel({ y, text }: { y: number; text: string }) {
  return (
    <text x={CORTEX_CENTER.x} y={y} textAnchor="middle" className="fill-muted-foreground text-2xs">
      {text}
    </text>
  );
}

function FilterRow({
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
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{label}</legend>
      <span className="text-xs text-muted-foreground" aria-hidden="true">
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
