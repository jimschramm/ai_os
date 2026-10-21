import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useId, useState } from "react";
import type { UsageMeasurementV1 } from "@t3tools/ai-os-contracts";

import { agentColor, providerGauges, type ProviderGauge } from "./boardVisuals";
import { formatShare, formatUsdMinor } from "./model";

export function UsageGauges({ entries }: { entries: readonly UsageMeasurementV1[] }) {
  const [shape, setShape] = useState<"orb" | "bar">("orb");
  const gauges = providerGauges(entries);
  return (
    <section
      aria-labelledby="usage-heading"
      className="ops-visual rounded-2xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="usage-heading" className="text-sm font-semibold tracking-tight">
            Usage
          </h2>
          <p className="text-2xs text-muted-foreground">
            Reported, estimated, subscription, and unknown stay separate.
          </p>
        </div>
        <div role="group" aria-label="Usage shape" className="flex gap-1">
          <Button
            size="sm"
            variant={shape === "orb" ? "secondary" : "outline"}
            aria-pressed={shape === "orb"}
            onClick={() => setShape("orb")}
          >
            Orb
          </Button>
          <Button
            size="sm"
            variant={shape === "bar" ? "secondary" : "outline"}
            aria-pressed={shape === "bar"}
            onClick={() => setShape("bar")}
          >
            Bar
          </Button>
        </div>
      </div>
      {gauges.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No usage yet.</p>
      ) : shape === "orb" ? (
        <ul className="mt-4 flex flex-wrap gap-6">
          {gauges.map((gauge) => (
            <li key={gauge.agentId}>
              <GaugeOrb gauge={gauge} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {gauges.map((gauge) => (
            <li key={gauge.agentId}>
              <GaugeBars gauge={gauge} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GaugeOrb({ gauge }: { gauge: ProviderGauge }) {
  const rawId = useId().replace(/:/g, "");
  const liquidY = 106 - gauge.liquid * 92;
  const fill = liquidColor(gauge);
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 120 120" className="size-28 shrink-0" role="img">
        <title>
          {gauge.label}, {gauge.percent} {gauge.caption}
        </title>
        <defs>
          <clipPath id={`${rawId}-clip`}>
            <rect x="0" y={liquidY} width="120" height="120" />
          </clipPath>
          <radialGradient id={`${rawId}-glass`} cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="var(--ops-cluster-white)" stopOpacity="0.28" />
            <stop offset="55%" stopColor="var(--ops-cluster-white)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--ops-cluster-white)" stopOpacity="0" />
          </radialGradient>
          <pattern id={`${rawId}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M0 6 L6 0" stroke="var(--muted-foreground)" strokeWidth="1" />
          </pattern>
        </defs>
        <circle cx="60" cy="60" r="46" fill="var(--muted)" opacity="0.45" />
        {gauge.unknownOnly ? (
          <circle cx="60" cy="60" r="46" fill={`url(#${rawId}-hatch)`} />
        ) : (
          <circle
            cx="60"
            cy="60"
            r="46"
            fill={fill}
            clipPath={`url(#${rawId}-clip)`}
            opacity="0.9"
          />
        )}
        <circle
          cx="60"
          cy="60"
          r="46"
          fill={`url(#${rawId}-glass)`}
          stroke="var(--ops-cluster-white)"
          strokeOpacity="0.35"
        />
        {gauge.unknownOnly ? null : (
          <g className="ops-sparkle">
            <circle cx="46" cy="38" r="1.3" fill="var(--ops-cluster-white)" />
            <circle cx="74" cy="46" r="1.1" fill="var(--ops-cluster-white)" />
            <circle cx="58" cy="30" r="0.9" fill="var(--ops-cluster-white)" />
          </g>
        )}
        <circle cx="60" cy="64" r="14" fill={agentColor(gauge.label)} />
        <text x="60" y="68" textAnchor="middle" className="ops-avatar-mark text-xs font-semibold">
          {gauge.mark}
        </text>
      </svg>
      <div>
        <p className="text-3xl font-semibold tracking-tight">{gauge.percent}</p>
        <p className="text-sm font-medium">{gauge.label}</p>
        <p className="text-2xs text-muted-foreground">{gauge.caption}</p>
        <KindMarks gauge={gauge} />
      </div>
    </div>
  );
}

function GaugeBars({ gauge }: { gauge: ProviderGauge }) {
  return (
    <div>
      <p className="text-sm font-medium">{gauge.label}</p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Meter
          label="Reported"
          value={gauge.reportedTokens.toLocaleString("en-US")}
          ratio={gauge.tokenRatio}
          tone="info"
        />
        <Meter
          label="Estimated"
          value={formatUsdMinor(gauge.estimatedCostMinor)}
          ratio={gauge.costRatio}
          tone="warning"
        />
        <Meter
          label="Subscription"
          value={formatShare(gauge.subscriptionBps)}
          ratio={gauge.subscriptionRatio}
          tone="success"
        />
        <Meter
          label="Unknown"
          value={String(gauge.unknown)}
          ratio={gauge.unknown > 0 ? 1 : 0}
          tone="unknown"
        />
      </div>
    </div>
  );
}

function Meter({
  label,
  value,
  ratio,
  tone,
}: {
  label: string;
  value: string;
  ratio: number;
  tone: "info" | "warning" | "success" | "unknown";
}) {
  const width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  const fill =
    tone === "info"
      ? "bg-info"
      : tone === "warning"
        ? "bg-warning"
        : tone === "success"
          ? "bg-success"
          : "ops-hatch";
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-2 rounded-full ${fill}`} style={{ width }} />
      </div>
    </div>
  );
}

function KindMarks({ gauge }: { gauge: ProviderGauge }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1" aria-label="Measurement kinds">
      <KindPill on={gauge.reportedTokens > 0} tone="info" label="Reported" />
      <KindPill on={gauge.estimatedCostMinor > 0} tone="warning" label="Estimated" />
      <KindPill on={gauge.subscriptionBps > 0} tone="success" label="Subscription" />
      <KindPill on={gauge.unknown > 0} tone="unknown" label="Unknown" />
    </ul>
  );
}

function KindPill({
  on,
  tone,
  label,
}: {
  on: boolean;
  tone: "info" | "warning" | "success" | "unknown";
  label: string;
}) {
  return (
    <li>
      <Badge size="sm" variant={on ? "secondary" : "outline"}>
        <span
          aria-hidden="true"
          className={`mr-1 inline-block size-1.5 rounded-full ${
            !on
              ? "bg-muted-foreground"
              : tone === "info"
                ? "bg-info"
                : tone === "warning"
                  ? "bg-warning"
                  : tone === "success"
                    ? "bg-success"
                    : "ops-hatch"
          }`}
        />
        {label}
      </Badge>
    </li>
  );
}

function liquidColor(gauge: ProviderGauge): string {
  if (gauge.caption === "subscription") return "var(--success)";
  if (gauge.caption === "estimated") return "var(--warning)";
  if (gauge.caption === "unknown") return "var(--muted-foreground)";
  return "var(--info)";
}
