import { ADAPTER_ANTIGRAVITY_MODELS_PATH } from "@t3tools/ai-os-adapter/board";
import { useEffect, useState } from "react";

import { primaryFetchInit } from "../../environments/primary/primaryRequest";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import { postBoardMove } from "./boardMove";
import type { OperationsTask } from "./fixtures";

interface CatalogModel {
  readonly slug: string;
  readonly label: string;
}

interface ModelCatalog {
  readonly source: "cli" | "unverified";
  readonly models: readonly CatalogModel[];
  readonly detail: string | null;
}

const emptyCatalog = (detail: string): ModelCatalog => ({
  source: "unverified",
  models: [],
  detail,
});

let reviewSequence = 0;
const reviewKey = (): string => {
  reviewSequence += 1;
  return `agy${reviewSequence.toString(36)}t${Math.floor(performance.now()).toString(36)}`;
};

// The board wire encodes a model ref as a slug. A decoded ref is `{ model }`.
const modelName = (model: { readonly model: string } | string | null): string => {
  if (model === null) return "CLI did not report";
  return typeof model === "string" ? model : model.model;
};

async function readCatalog(): Promise<ModelCatalog> {
  let url: string;
  try {
    url = resolvePrimaryEnvironmentHttpUrl(ADAPTER_ANTIGRAVITY_MODELS_PATH);
  } catch {
    return emptyCatalog("The board server is not connected. A typed model stays unverified.");
  }
  const init = await primaryFetchInit();
  const response = await fetch(url, init);
  if (!response.ok) {
    return emptyCatalog("The CLI model list is unavailable. A typed model stays unverified.");
  }
  const body = (await response.json()) as Partial<ModelCatalog>;
  if (body.source !== "cli" && body.source !== "unverified") {
    return emptyCatalog("The CLI model list is unavailable. A typed model stays unverified.");
  }
  return {
    source: body.source,
    models: Array.isArray(body.models) ? body.models : [],
    detail: typeof body.detail === "string" ? body.detail : null,
  };
}

export function AdvisoryReviewSection({ task, live }: { task: OperationsTask; live: boolean }) {
  const review = task.advisory ?? null;
  const taskType =
    task.assignment?.taskType ?? (task.assignment?.role === "advisory" ? "advisory" : undefined);
  const canChoose =
    live && taskType === "advisory" && (task.phase === "assigned" || task.phase === "rework");
  if (review === null && !canChoose) return null;
  return (
    <section aria-labelledby="advisory-heading">
      <h3 id="advisory-heading" className="text-sm font-semibold">
        {task.phase === "review_delivered" ? "Review delivered" : "Advisory review"}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Findings from this review do not replace independent QA.
      </p>
      {review === null ? null : (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p>
            Requested {modelName(review.model.requested)}. Ran {modelName(review.model.actual)}.
          </p>
          {review.model.unverified ? <Badge variant="outline">unverified</Badge> : null}
          <p className="font-mono text-xs">{review.commit}</p>
          {review.findings.length === 0 ? (
            <p className="text-muted-foreground">No findings.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {review.findings.map((finding) => (
                <li key={`${finding.evidence}:${finding.suggestedAction}`}>
                  <p>{finding.evidence}</p>
                  <p className="text-muted-foreground">{finding.suggestedAction}</p>
                  <p className="font-mono text-xs">{finding.files.join(", ")}</p>
                </li>
              ))}
            </ul>
          )}
          {review.artifacts.length === 0 ? null : (
            <ul className="flex flex-col gap-1">
              {review.artifacts.map((artifact) => (
                <li key={artifact.artifactId}>{artifact.note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canChoose ? <ModelPicker taskId={task.id} /> : null}
    </section>
  );
}

function ModelPicker({ taskId }: { taskId: string }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readCatalog().then((next) => {
      if (cancelled) return;
      setCatalog(next);
      const first = next.models[0]?.slug;
      if (next.source === "unverified" && first !== undefined) setModel(first);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const unverified = catalog?.source !== "cli";
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await postBoardMove(taskId, "Running", reviewKey(), false, model);
      setAlert(result._tag === "Rejected" ? (result.detail ?? "The review did not start.") : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <label htmlFor={`antigravity-model-${taskId}`} className="text-sm">
        Antigravity model
        {unverified ? <span className="text-muted-foreground"> · unverified</span> : null}
      </label>
      {catalog?.source === "cli" && catalog.models.length > 0 ? (
        <select
          id={`antigravity-model-${taskId}`}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={model}
          onChange={(event) => setModel(event.currentTarget.value)}
        >
          <option value="">Choose a model</option>
          {catalog.models.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`antigravity-model-${taskId}`}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={model}
          onChange={(event) => setModel(event.currentTarget.value)}
          spellCheck={false}
        />
      )}
      {catalog?.detail ? <p className="text-xs text-muted-foreground">{catalog.detail}</p> : null}
      {alert === null ? null : (
        <p role="alert" className="text-sm">
          {alert}
        </p>
      )}
      <div>
        <Button size="sm" disabled={busy || model.trim().length === 0} onClick={() => void run()}>
          Run advisory review
        </Button>
      </div>
    </div>
  );
}
