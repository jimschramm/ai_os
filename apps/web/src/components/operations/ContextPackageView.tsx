import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

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
  const requirements = snapshot.records.filter((fact) => memoryType(fact.kind) === "facts");

  return (
    <div className="mt-2 flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Immutable package from {formatInstant(snapshot.createdAt)}. Later memory edits are not in
        it.
      </p>
      <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-lg border border-border/80 bg-background/40 px-3 py-2">
          <dt className="text-muted-foreground">Repository</dt>
          <dd className="mt-1 font-mono">{snapshot.repoCommit.slice(0, 7)}</dd>
        </div>
        <div className="rounded-lg border border-border/80 bg-background/40 px-3 py-2">
          <dt className="text-muted-foreground">Authorization</dt>
          <dd className="mt-1">{snapshot.authorizationScope}</dd>
        </div>
      </dl>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">Requirements</h4>
        <p className="mt-1 text-sm leading-6">{snapshot.requirements}</p>
        <RecordList records={requirements} onOpenRecord={onOpenRecord} />
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">Governing instructions</h4>
        <RecordList records={instructions} onOpenRecord={onOpenRecord} />
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">Current decisions</h4>
        <RecordList records={decisions} onOpenRecord={onOpenRecord} />
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">Memory versions</h4>
        <ul className="mt-2 flex flex-col gap-2">
          {snapshot.records.map((fact) => (
            <li
              key={fact.factId}
              className="rounded-lg border border-border/80 bg-background/40 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge size="sm" variant="secondary">
                  {fact.kind}
                </Badge>
                <span className="font-mono text-2xs text-muted-foreground">{fact.factId}</span>
              </div>
              <p className="mt-2 text-sm">{fact.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">{formatProvenance(fact)}</p>
              <EvidenceList factId={fact.factId} />
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => onOpenRecord(fact.factId)}>
                  Open record
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        Attempt revision {shortRevision(task)} is separate from these memory versions.
      </p>
    </div>
  );
}

function RecordList({
  records,
  onOpenRecord,
}: {
  records: readonly MemoryFactV1[];
  onOpenRecord: (factId: string) => void;
}) {
  if (records.length === 0) {
    return <p className="mt-1 text-sm text-muted-foreground">None in this package.</p>;
  }
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {records.map((fact) => (
        <li key={fact.factId}>
          <button
            type="button"
            onClick={() => onOpenRecord(fact.factId)}
            className="w-full rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-left transition-colors duration-150 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="block text-sm">{fact.body}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {formatProvenance(fact)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EvidenceList({ factId }: { factId: string }) {
  const evidence = linkedEvidence(factId);
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
      {evidence.map((item) => (
        <li key={`${item.label}:${item.detail}`}>
          {item.label}: {item.detail}
        </li>
      ))}
    </ul>
  );
}
