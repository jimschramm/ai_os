import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useState } from "react";

import type { MemoryFactV1 } from "@t3tools/ai-os-contracts";

import type { OperationsTask } from "./fixtures";
import { contextPackageView, formatProvenance, linkedEvidence, memoryType } from "./memoryModel";
import { formatInstant, shortRevision } from "./model";

export function ContextPackageView({
  task,
  onOpenRecord,
}: {
  task: OperationsTask;
  onOpenRecord: (factId: string) => void;
}) {
  const snapshot = contextPackageView(task);
  if (snapshot === null) {
    return <p className="mt-2 text-sm text-muted-foreground">No context package was issued.</p>;
  }
  const instructions = snapshot.records.filter((fact) => fact.kind === "Instruction");
  const decisions = snapshot.records.filter((fact) => fact.kind === "Decision");
  const facts = snapshot.records.filter((fact) => memoryType(fact.kind) === "facts");
  const used = new Set([...instructions, ...decisions, ...facts].map((fact) => fact.factId));
  const others = snapshot.records.filter((fact) => !used.has(fact.factId));

  return (
    <div className="mt-2 flex flex-col gap-3">
      <p className="text-2xs text-muted-foreground">
        {formatInstant(snapshot.createdAt)} · {snapshot.repoCommit.slice(0, 7)} ·{" "}
        {snapshot.authorizationScope}
      </p>
      <ChipGroup
        title="Requirements"
        chips={[
          { id: "requirements", label: "Requirements", body: snapshot.requirements, fact: null },
          ...facts.map(chipFromFact),
        ]}
        onOpenRecord={onOpenRecord}
      />
      <ChipGroup
        title="Instructions"
        chips={instructions.map(chipFromFact)}
        onOpenRecord={onOpenRecord}
      />
      <ChipGroup
        title="Decisions"
        chips={decisions.map(chipFromFact)}
        onOpenRecord={onOpenRecord}
      />
      {others.length === 0 ? null : (
        <ChipGroup
          title="Other versions"
          chips={others.map(chipFromFact)}
          onOpenRecord={onOpenRecord}
        />
      )}
      <p className="text-2xs text-muted-foreground">Attempt {shortRevision(task)}</p>
    </div>
  );
}

interface Chip {
  readonly id: string;
  readonly label: string;
  readonly body: string;
  readonly fact: MemoryFactV1 | null;
}

function chipFromFact(fact: MemoryFactV1): Chip {
  return { id: fact.factId, label: shortLabel(fact.body), body: fact.body, fact };
}

function ChipGroup({
  title,
  chips,
  onOpenRecord,
}: {
  title: string;
  chips: readonly Chip[];
  onOpenRecord: (factId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = chips.find((chip) => chip.id === openId) ?? null;
  if (chips.length === 0) return null;
  return (
    <div>
      <h4 className="text-2xs font-medium text-muted-foreground">{title}</h4>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {chips.map((chip) => {
          const expanded = chip.id === openId;
          return (
            <li key={chip.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenId(expanded ? null : chip.id)}
                className="rounded-full border border-border bg-background/60 px-2.5 py-1 text-2xs hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              >
                {chip.label}
              </button>
            </li>
          );
        })}
      </ul>
      {open === null ? null : (
        <div className="mt-2 rounded-lg border border-border/80 bg-background/40 px-3 py-2">
          <p className="text-sm">{open.body}</p>
          {open.fact === null ? null : (
            <>
              <p className="mt-1 text-2xs text-muted-foreground">{formatProvenance(open.fact)}</p>
              <EvidenceLines factId={open.fact.factId} />
              <div className="mt-2 flex items-center gap-2">
                <Badge size="sm" variant="secondary">
                  {open.fact.kind}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => onOpenRecord(open.fact!.factId)}>
                  Open record
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceLines({ factId }: { factId: string }) {
  const evidence = linkedEvidence(factId);
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-muted-foreground">
      {evidence.map((item) => (
        <li key={`${item.label}:${item.detail}`}>
          {item.label}: {item.detail}
        </li>
      ))}
    </ul>
  );
}

function shortLabel(body: string): string {
  const clean = body.replace(/\.$/, "");
  return clean.length > 32 ? `${clean.slice(0, 32)}…` : clean;
}
