import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useEffect, useId, useRef, useState } from "react";

import {
  CLUSTER_KINDS,
  CORTEX_HUB,
  CORTEX_LINK_COUNT,
  CORTEX_NODE_COUNT,
  DETAIL_LEVELS,
  MEMORY_SOURCES,
  defaultSourceToggles,
  matchesQuery,
  memorySourceFor,
  neuralField,
  timelineField,
  type ClusterId,
  type DetailLevel,
  type FieldArc,
  type FieldRecord,
  type MemorySourceId,
} from "./cortexField";
import {
  CORTEX_CENTER,
  CORTEX_RING_RADIUS,
  arcPath,
  layoutCortex,
  type CortexNode,
  type MemoryReviewState,
} from "./memoryModel";

type CortexMode = "neural" | "rings" | "timeline";

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
  const [mode, setMode] = useState<CortexMode>("neural");
  const [level, setLevel] = useState<DetailLevel>("full");
  const [query, setQuery] = useState("");
  const [orbit, setOrbit] = useState(true);
  const [flow, setFlow] = useState(true);
  const [linksOn, setLinksOn] = useState(true);
  const [sourceOn, setSourceOn] = useState(defaultSourceToggles);
  const [fresh, setFresh] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [focus, setFocus] = useState<{ source: string | null; id: string | null }>({
    source: highlightId,
    id: highlightId,
  });
  const focusedId = focus.source === highlightId ? focus.id : highlightId;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const glowId = useId().replace(/:/g, "");
  const searchId = useId();
  const enabledSources = new Set(
    MEMORY_SOURCES.filter((source) => sourceOn[source.id]).map((source) => source.id),
  );
  const field = neuralField({ projectId, review, level, enabledSources, query });
  const timeline = timelineField({ projectId, review, enabledSources, query });
  const rings = layoutCortex(projectId, review, {
    scope: "all",
    status: "all",
    currentTaskId,
  });
  const ringNodes = rings.nodes.filter((node) => {
    const sourceId = memorySourceFor(node.fact.factId);
    return (
      sourceId !== null &&
      enabledSources.has(sourceId) &&
      matchesQuery(query, node.fact.body, node.fact.factId)
    );
  });
  const ringIds = new Set(ringNodes.map((node) => node.fact.factId));
  const shown =
    mode === "neural"
      ? field.shown
      : mode === "timeline"
        ? timeline.nodes.length
        : ringNodes.length;
  const listed =
    mode === "rings"
      ? ringNodes.map(recordFromRing)
      : mode === "timeline"
        ? timeline.nodes
        : field.records;
  const focused =
    listed.find((record) => record.factId === focusedId) ??
    listed.find((record) => record.conflicting) ??
    listed[0] ??
    null;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = event.deltaY > 0 ? -0.08 : 0.08;
      setTransform((current) => ({ ...current, scale: clamp(current.scale + next, 0.65, 2.4) }));
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, []);

  const open = (factId: string) => {
    setFocus({ source: highlightId, id: factId });
    onOpenRecord(factId);
  };

  return (
    <section
      aria-labelledby="cortex-heading"
      className="ops-visual flex flex-col gap-3"
      data-mode={mode}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="cortex-heading" className="text-sm font-semibold tracking-tight">
          Cortex
        </h2>
        <div role="tablist" aria-label="Cortex view" className="flex flex-wrap gap-1">
          <ModeTab selected={mode === "neural"} onClick={() => setMode("neural")}>
            Neural
          </ModeTab>
          <ModeTab selected={mode === "rings"} onClick={() => setMode("rings")}>
            Rings
          </ModeTab>
          <ModeTab selected={mode === "timeline"} onClick={() => setMode("timeline")}>
            Timeline
          </ModeTab>
          <Button size="sm" variant="outline" disabled>
            Sphere
          </Button>
          <Button size="sm" variant="outline" disabled>
            Network
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <label className="sr-only" htmlFor={searchId}>
            Find a memory
          </label>
          <Input
            id={searchId}
            type="search"
            size="sm"
            placeholder="Find a memory..."
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {CORTEX_NODE_COUNT.toLocaleString("en-US")} nodes ·{" "}
          {CORTEX_LINK_COUNT.toLocaleString("en-US")} links
        </p>
        <Button
          size="sm"
          variant={orbit ? "secondary" : "outline"}
          aria-pressed={orbit}
          onClick={() => setOrbit((on) => !on)}
        >
          {orbit ? "Orbit on" : "Orbit"}
        </Button>
        <Button
          size="sm"
          variant={flow ? "secondary" : "outline"}
          aria-pressed={flow}
          onClick={() => setFlow((on) => !on)}
        >
          {flow ? "Flow on" : "Flow"}
        </Button>
        <Button
          size="sm"
          variant={linksOn ? "secondary" : "outline"}
          aria-pressed={linksOn}
          onClick={() => setLinksOn((on) => !on)}
        >
          {linksOn ? "Links on" : "Links"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
          Fit all
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <div className="relative xl:col-span-3">
          <div
            ref={surfaceRef}
            className="ops-starfield relative aspect-video overflow-hidden rounded-2xl border border-border"
            tabIndex={0}
            aria-label="Memory graph. Arrow keys pan. Plus and minus zoom."
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
              if (event.key === "+" || event.key === "=") {
                setTransform((current) => ({
                  ...current,
                  scale: clamp(current.scale + 0.15, 0.65, 2.4),
                }));
              }
              if (event.key === "-" || event.key === "_") {
                setTransform((current) => ({
                  ...current,
                  scale: clamp(current.scale - 0.15, 0.65, 2.4),
                }));
              }
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
          >
            {mode === "neural" ? (
              <NeuralGraph
                glowId={glowId}
                field={field}
                projectLabel={projectLabel}
                orbit={orbit}
                flow={flow}
                linksOn={linksOn}
                transform={transform}
                focusedId={focused?.factId ?? null}
                onOpen={open}
                onFocus={(factId) => setFocus({ source: highlightId, id: factId })}
              />
            ) : null}
            {mode === "rings" ? (
              <RingsGraph
                glowId={glowId}
                nodes={ringNodes}
                arcs={rings.arcs.filter((arc) => ringIds.has(arc.fromId) && ringIds.has(arc.toId))}
                projectLabel={projectLabel}
                conflictCount={rings.conflictCount}
                transform={transform}
                focusedId={focused?.factId ?? null}
                onOpen={open}
                onFocus={(factId) => setFocus({ source: highlightId, id: factId })}
              />
            ) : null}
            {mode === "timeline" ? (
              <TimelineGraph
                glowId={glowId}
                layout={timeline}
                linksOn={linksOn}
                transform={transform}
                focusedId={focused?.factId ?? null}
                onOpen={open}
                onFocus={(factId) => setFocus({ source: highlightId, id: factId })}
              />
            ) : null}
            <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-1">
              <DetailControl level={level} onChange={setLevel} />
              <p className="rounded-full bg-background/80 px-2 py-1 text-2xs text-muted-foreground">
                {shown.toLocaleString("en-US")} of {CORTEX_NODE_COUNT.toLocaleString("en-US")} shown
              </p>
            </div>
          </div>
        </div>
        <SourcesPanel
          sourceOn={sourceOn}
          fresh={fresh}
          onToggle={(id) => setSourceOn((current) => ({ ...current, [id]: !current[id] }))}
          onRefresh={() => setFresh(true)}
        />
      </div>
      <p aria-live="polite" className="text-sm">
        {focused === null ? "Nothing in this view" : focused.body}
        {focused?.conflicting ? " · competing claim" : focused ? ` · ${focused.status}` : ""}
      </p>
      <section aria-labelledby="cortex-list-heading">
        <h3 id="cortex-list-heading" className="text-sm font-semibold">
          Records
        </h3>
        <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-auto">
          {listed.map((record) => (
            <li key={record.factId}>
              <button
                type="button"
                onClick={() => open(record.factId)}
                onFocus={() => setFocus({ source: highlightId, id: record.factId })}
                className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className={record.dimmed ? "text-muted-foreground" : undefined}>
                  {record.body}
                </span>
                <span className="mt-0.5 block text-2xs text-muted-foreground">
                  {record.status}
                  {record.conflicting ? " · competing" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function recordFromRing(node: CortexNode): FieldRecord {
  return {
    factId: node.fact.factId,
    body: node.fact.body,
    clusterId: "facts",
    sourceId: memorySourceFor(node.fact.factId) ?? "tam",
    status: node.status,
    x: node.x,
    y: node.y,
    at: node.fact.provenance.at,
    dimmed: node.dimmed,
    conflicting: node.conflicting,
  };
}

function NeuralGraph({
  glowId,
  field,
  projectLabel,
  orbit,
  flow,
  linksOn,
  transform,
  focusedId,
  onOpen,
  onFocus,
}: {
  glowId: string;
  field: ReturnType<typeof neuralField>;
  projectLabel: string;
  orbit: boolean;
  flow: boolean;
  linksOn: boolean;
  transform: { x: number; y: number; scale: number };
  focusedId: string | null;
  onOpen: (factId: string) => void;
  onFocus: (factId: string) => void;
}) {
  return (
    <svg viewBox="0 0 1000 620" className="h-full w-full touch-none" aria-hidden="true">
      <GraphDefs glowId={glowId} />
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
        {linksOn
          ? field.neighborLinks.map((link) => (
              <path key={link.id} d={link.d} fill="none" stroke="var(--ops-link)" strokeWidth="1" />
            ))
          : null}
        {linksOn
          ? field.hubLinks.map((link) => (
              <path
                key={link.clusterId}
                d={link.d}
                fill="none"
                stroke="var(--ops-link)"
                strokeWidth="1.25"
                className={flow ? "ops-flow" : undefined}
              />
            ))
          : null}
        <circle cx={CORTEX_HUB.x} cy={CORTEX_HUB.y} r="46" fill={`url(#${glowId}-hub)`} />
        <circle cx={CORTEX_HUB.x} cy={CORTEX_HUB.y} r="16" fill="var(--ops-cluster-white)" />
        <text x={CORTEX_HUB.x} y={CORTEX_HUB.y + 36} textAnchor="middle" className="text-2xs">
          {projectLabel}
        </text>
        {CLUSTER_KINDS.map((cluster) => {
          const satellites = field.satellites.filter((dot) => dot.clusterId === cluster.id);
          const records = field.records.filter((record) => record.clusterId === cluster.id);
          const arcs = field.arcs.filter((arc) => arc.clusterId === cluster.id);
          return (
            <g key={cluster.id}>
              <circle cx={cluster.x} cy={cluster.y} r="42" fill={`url(#${glowId}-${cluster.id})`} />
              <circle cx={cluster.x} cy={cluster.y} r="8" fill={cluster.color} />
              <g className={orbit ? "ops-orbit" : undefined}>
                {satellites.map((dot) => (
                  <circle
                    key={dot.id}
                    cx={dot.x}
                    cy={dot.y}
                    r="2.2"
                    fill={cluster.color}
                    opacity="0.9"
                  />
                ))}
                {linksOn ? arcs.map((arc) => <ArcShape key={arc.id} arc={arc} />) : null}
                {records.map((record) => (
                  <RecordOrb
                    key={record.factId}
                    record={record}
                    color={cluster.color}
                    glow={`url(#${glowId}-glow)`}
                    selected={record.factId === focusedId}
                    onOpen={() => onOpen(record.factId)}
                    onFocus={() => onFocus(record.factId)}
                  />
                ))}
              </g>
            </g>
          );
        })}
        {linksOn
          ? field.arcs
              .filter((arc) => arc.clusterId === null)
              .map((arc) => <ArcShape key={arc.id} arc={arc} />)
          : null}
      </g>
    </svg>
  );
}

function RingsGraph({
  glowId,
  nodes,
  arcs,
  projectLabel,
  conflictCount,
  transform,
  focusedId,
  onOpen,
  onFocus,
}: {
  glowId: string;
  nodes: readonly CortexNode[];
  arcs: ReturnType<typeof layoutCortex>["arcs"];
  projectLabel: string;
  conflictCount: number;
  transform: { x: number; y: number; scale: number };
  focusedId: string | null;
  onOpen: (factId: string) => void;
  onFocus: (factId: string) => void;
}) {
  return (
    <svg viewBox="0 0 720 720" className="h-full w-full touch-none" aria-hidden="true">
      <GraphDefs glowId={glowId} />
      <g
        transform={`translate(${CORTEX_CENTER.x + transform.x} ${CORTEX_CENTER.y + transform.y}) scale(${transform.scale}) translate(${-CORTEX_CENTER.x} ${-CORTEX_CENTER.y})`}
      >
        {(["inner", "mid", "outer"] as const).map((ring) => (
          <circle
            key={ring}
            cx={CORTEX_CENTER.x}
            cy={CORTEX_CENTER.y}
            r={CORTEX_RING_RADIUS[ring]}
            fill="none"
            stroke="var(--ops-link)"
          />
        ))}
        {arcs.map((arc) => (
          <path
            key={`${arc.fromId}-${arc.toId}`}
            d={arcPath(arc.from, arc.to)}
            fill="none"
            stroke="var(--ops-link-strong)"
            strokeWidth="1.4"
          />
        ))}
        <circle cx={CORTEX_CENTER.x} cy={CORTEX_CENTER.y} r="48" fill={`url(#${glowId}-hub)`} />
        <circle cx={CORTEX_CENTER.x} cy={CORTEX_CENTER.y} r="14" fill="var(--ops-cluster-white)" />
        <text x={CORTEX_CENTER.x} y={CORTEX_CENTER.y + 34} textAnchor="middle" className="text-2xs">
          {projectLabel}
          {conflictCount > 0 ? ` · ${conflictCount}` : ""}
        </text>
        {nodes.map((node) => {
          const sourceId = memorySourceFor(node.fact.factId);
          const cluster =
            CLUSTER_KINDS.find((item) => item.id === clusterIdForRing(node)) ?? CLUSTER_KINDS[0]!;
          const record: FieldRecord = {
            factId: node.fact.factId,
            body: node.fact.body,
            clusterId: cluster.id,
            sourceId: sourceId ?? "tam",
            status: node.status,
            x: node.x,
            y: node.y,
            at: node.fact.provenance.at,
            dimmed: node.dimmed,
            conflicting: node.conflicting,
          };
          return (
            <RecordOrb
              key={node.fact.factId}
              record={record}
              color={cluster.color}
              glow={`url(#${glowId}-glow)`}
              selected={node.fact.factId === focusedId}
              onOpen={() => onOpen(node.fact.factId)}
              onFocus={() => onFocus(node.fact.factId)}
            />
          );
        })}
      </g>
    </svg>
  );
}

function clusterIdForRing(node: CortexNode): ClusterId {
  if (node.ring === "inner") return node.fact.kind === "Decision" ? "decisions" : "instructions";
  if (node.ring === "outer") return node.fact.kind === "Artifact" ? "artifacts" : "tasks";
  if (node.fact.kind === "User") return "preferences";
  if (node.fact.kind === "Procedure") return "working";
  if (node.fact.kind === "Handoff") return "handoffs";
  return "facts";
}

function TimelineGraph({
  glowId,
  layout,
  linksOn,
  transform,
  focusedId,
  onOpen,
  onFocus,
}: {
  glowId: string;
  layout: ReturnType<typeof timelineField>;
  linksOn: boolean;
  transform: { x: number; y: number; scale: number };
  focusedId: string | null;
  onOpen: (factId: string) => void;
  onFocus: (factId: string) => void;
}) {
  return (
    <svg viewBox="0 0 1000 560" className="h-full w-full touch-none" aria-hidden="true">
      <GraphDefs glowId={glowId} />
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
        {layout.lanes.map((lane) => (
          <g key={lane.id}>
            <line x1="88" y1={lane.y} x2="940" y2={lane.y} stroke="var(--ops-link)" />
            <text x="16" y={lane.y + 4} className="text-2xs">
              {lane.label}
            </text>
          </g>
        ))}
        <text x="96" y="528" className="text-2xs">
          {layout.startLabel}
        </text>
        <text x="860" y="528" className="text-2xs">
          {layout.endLabel}
        </text>
        {linksOn ? layout.arcs.map((arc) => <ArcShape key={arc.id} arc={arc} />) : null}
        {layout.nodes.map((record) => {
          const cluster =
            CLUSTER_KINDS.find((item) => item.id === record.clusterId) ?? CLUSTER_KINDS[0]!;
          return (
            <RecordOrb
              key={record.factId}
              record={record}
              color={cluster.color}
              glow={`url(#${glowId}-glow)`}
              selected={record.factId === focusedId}
              onOpen={() => onOpen(record.factId)}
              onFocus={() => onFocus(record.factId)}
            />
          );
        })}
      </g>
    </svg>
  );
}

function GraphDefs({ glowId }: { glowId: string }) {
  return (
    <defs>
      <radialGradient id={`${glowId}-hub`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="var(--ops-cluster-white)" stopOpacity="0.95" />
        <stop offset="40%" stopColor="var(--ops-cluster-blue)" stopOpacity="0.35" />
        <stop offset="100%" stopColor="var(--ops-cluster-blue)" stopOpacity="0" />
      </radialGradient>
      {CLUSTER_KINDS.map((cluster) => (
        <radialGradient key={cluster.id} id={`${glowId}-${cluster.id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={cluster.color} stopOpacity="0.95" />
          <stop offset="42%" stopColor={cluster.color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={cluster.color} stopOpacity="0" />
        </radialGradient>
      ))}
      <filter id={`${glowId}-glow`} x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="3.5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function ArcShape({ arc }: { arc: FieldArc }) {
  const conflicting = arc.kind === "conflict";
  return (
    <path
      d={arcPath(arc.from, arc.to)}
      fill="none"
      stroke={conflicting ? "var(--warning)" : "var(--ops-link-strong)"}
      strokeWidth={conflicting ? 1.6 : 1.2}
      opacity={conflicting ? 0.95 : 0.7}
      className={conflicting ? "ops-pulse" : undefined}
    />
  );
}

function RecordOrb({
  record,
  color,
  glow,
  selected,
  onOpen,
  onFocus,
}: {
  record: FieldRecord;
  color: string;
  glow: string;
  selected: boolean;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const proposed = record.status === "proposed";
  const rejected = record.status === "rejected";
  const fill = proposed ? "none" : rejected ? "var(--destructive)" : color;
  const stroke = rejected ? "var(--destructive)" : record.conflicting ? "var(--warning)" : color;
  return (
    <g
      data-memory-node=""
      transform={`translate(${record.x} ${record.y})`}
      opacity={record.status === "superseded" ? 0.38 : 1}
      onClick={onOpen}
      onMouseEnter={onFocus}
      onFocus={onFocus}
    >
      {record.conflicting ? (
        <circle r="16" fill="var(--warning)" opacity="0.45" filter={glow} className="ops-pulse" />
      ) : null}
      <circle r="11" fill="transparent" />
      <circle r="6.5" fill={fill} stroke={stroke} strokeWidth={selected || proposed ? 2 : 1.25} />
    </g>
  );
}

function ModeTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      role="tab"
      aria-selected={selected}
      size="sm"
      variant={selected ? "secondary" : "outline"}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function DetailControl({
  level,
  onChange,
}: {
  level: DetailLevel;
  onChange: (level: DetailLevel) => void;
}) {
  return (
    <fieldset className="flex gap-1 rounded-full bg-background/80 p-1">
      <legend className="sr-only">Detail</legend>
      {DETAIL_LEVELS.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant={option.id === level ? "secondary" : "ghost"}
          aria-pressed={option.id === level}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}

function SourcesPanel({
  sourceOn,
  fresh,
  onToggle,
  onRefresh,
}: {
  sourceOn: Record<MemorySourceId, boolean>;
  fresh: boolean;
  onToggle: (id: MemorySourceId) => void;
  onRefresh: () => void;
}) {
  return (
    <aside
      aria-labelledby="sources-heading"
      className="rounded-2xl border border-border bg-card p-3"
    >
      <h3 id="sources-heading" className="text-sm font-semibold">
        Memory sources
      </h3>
      <ul className="mt-3 flex flex-col gap-2">
        {MEMORY_SOURCES.map((source) => (
          <li key={source.id} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="ops-avatar-mark grid size-7 shrink-0 place-items-center rounded-full text-2xs font-semibold"
              style={{ background: source.color }}
            >
              {source.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{source.label}</span>
              <span className="block text-2xs text-muted-foreground">
                {source.count.toLocaleString("en-US")} ·{" "}
                {fresh ? "updated just now" : `updated ${source.freshMin} min ago`}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={sourceOn[source.id]}
              aria-label={source.label}
              className="ops-switch shrink-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => onToggle(source.id)}
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="ops-refresh mt-3 h-8 w-full rounded-lg text-sm font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
        onClick={onRefresh}
      >
        Refresh all
      </button>
    </aside>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
