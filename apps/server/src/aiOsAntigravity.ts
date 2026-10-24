import {
  advisoryUsage,
  listAntigravityModels,
  resolveModelChoice,
  runAdvisoryReview,
  type AdvisoryExecution,
  type AdvisorySuccess,
  type AntigravityCatalog,
} from "@t3tools/ai-os-adapter";
import {
  applyBoardWorkflowEvent,
  decodeUsageMeasurementV1,
  executionGeneration,
  type ContextPackageSnapshotV1,
  type Intake,
  type KanbanMoveLedger,
  type KanbanMoveResult,
  type SequenceState,
} from "@t3tools/ai-os-contracts";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";

export class AntigravityReviews extends Context.Service<
  AntigravityReviews,
  {
    readonly listModels: () => Effect.Effect<AntigravityCatalog>;
    readonly start: (input: {
      readonly projectId: string;
      readonly taskId: string;
      readonly generation: number;
      readonly intake: Intake;
      readonly context: ContextPackageSnapshotV1;
      readonly requestedModel: string | undefined;
    }) => Effect.Effect<AdvisoryOpen>;
    readonly watch: (taskId: string) => Effect.Effect<AdvisoryWatch | null>;
    readonly cancel: (taskId: string) => Effect.Effect<"requested" | "already_stopped">;
  }
>()("t3/aiOsAntigravity/AntigravityReviews") {}

export type AdvisoryOpen =
  | {
      readonly status: "unavailable";
      readonly detail: string;
      readonly models: readonly string[];
    }
  | { readonly status: "running"; readonly runId: string }
  | { readonly status: "settled"; readonly runId: string; readonly execution: AdvisoryExecution };

export type AdvisoryWatch =
  | { readonly status: "running" }
  | { readonly status: "settled"; readonly execution: AdvisoryExecution };

const configuredModel = () => process.env.AI_OS_ANTIGRAVITY_MODEL;

const text = (value: string, fallback: string): string => {
  const trimmed = value.trim().slice(0, 8_000);
  return trimmed.length > 0 ? trimmed : fallback;
};

const evidenceRef = (value: string): string | null =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value.length <= 128 ? value : null;

const findingFiles = (files: readonly string[]): [string, ...string[]] | null => {
  const [first, ...rest] = files;
  return first === undefined ? null : [first, ...rest];
};

const rejected = (
  detail: string,
  state: SequenceState,
  ledger: KanbanMoveLedger,
): KanbanMoveResult => ({ _tag: "Rejected", detail, state, ledger });

/**
 * Fold a finished advisory run into sequence events. A stop before this
 * function leaves the card Ready and does not consume a generation.
 */
export const applyAdvisoryExecution = (input: {
  readonly state: SequenceState;
  readonly taskId: string;
  readonly ledger: KanbanMoveLedger;
  readonly execution: AdvisorySuccess;
  readonly workerId: string;
}): Effect.Effect<KanbanMoveResult> =>
  Effect.gen(function* () {
    if (
      input.state.phase !== "assigned" &&
      input.state.phase !== "rework" &&
      input.state.phase !== "executing"
    ) {
      return rejected(
        "In Progress starts from Ready only after a worker is assigned.",
        input.state,
        input.ledger,
      );
    }
    const execution = input.execution;
    const generation =
      input.state.phase === "executing"
        ? input.state.run.generation
        : executionGeneration(input.state);
    const attemptId = input.state.assignment.attemptId;
    const projectId = input.state.intake.projectId;
    let current: KanbanMoveResult = yield* applyBoardWorkflowEvent(
      input.state,
      { type: "start_execution" },
      `agy-start-${input.taskId}-${generation}`,
      input.taskId,
      input.ledger,
    );
    if (current._tag !== "Applied" || current.state.phase !== "executing") return current;

    const progressed = yield* applyBoardWorkflowEvent(
      current.state,
      {
        type: "report_progress",
        report: {
          version: "v1",
          taskId: input.taskId,
          attemptId,
          generation: current.state.run.generation,
          leaseId: current.state.run.leaseId,
          status: "working",
          blockers: [],
          partialArtifacts: [
            {
              artifactId: "advisory-note",
              revision: { type: "git", sha: execution.commit },
              note: text(execution.progressNote, "Advisory review is running."),
            },
          ],
        },
      },
      `agy-progress-${input.taskId}-${generation}`,
      input.taskId,
      current.ledger,
    );
    if (progressed._tag === "Applied") current = progressed;
    if (current.state.phase !== "executing") return current;

    const measurements = advisoryUsage({
      projectId,
      taskId: input.taskId,
      attemptId,
      agentId: input.workerId,
      requestedModel: execution.requestedModel,
      actualModel: execution.actualModel,
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
    });
    for (const [index, measurement] of measurements.entries()) {
      if (current.state.phase !== "executing") break;
      const decoded = yield* decodeUsageMeasurementV1(measurement).pipe(Effect.option);
      if (Option.isNone(decoded)) continue;
      const reported: KanbanMoveResult = yield* applyBoardWorkflowEvent(
        current.state,
        {
          type: "report_usage",
          generation: current.state.run.generation,
          leaseId: current.state.run.leaseId,
          measurement: decoded.value,
        },
        `agy-usage-${input.taskId}-${generation}-${index}`,
        input.taskId,
        current.ledger,
      );
      if (reported._tag === "Applied") current = reported;
    }
    if (current.state.phase !== "executing") return current;

    const commitRef = evidenceRef(execution.commit);
    const conversation =
      execution.conversationId === null ? null : evidenceRef(`conv-${execution.conversationId}`);
    const evidence =
      commitRef === null
        ? []
        : conversation === null
          ? [{ kind: "commit" as const, ref: commitRef }]
          : [
              { kind: "commit" as const, ref: commitRef },
              { kind: "readback" as const, ref: conversation },
            ];
    const findings = execution.findings.flatMap((finding) => {
      const files = findingFiles(finding.files);
      return files === null ? [] : [{ ...finding, files }];
    });
    const recorded = yield* applyBoardWorkflowEvent(
      current.state,
      {
        type: "record_advisory",
        review: {
          version: "v1",
          taskId: input.taskId,
          attemptId,
          generation: current.state.run.generation,
          leaseId: current.state.run.leaseId,
          mode: "advisory",
          commit: execution.commit,
          model: {
            requested: { model: execution.requestedModel },
            actual: execution.actualModel === null ? null : { model: execution.actualModel },
            unverified: execution.unverified,
          },
          findings,
          artifacts: [
            {
              artifactId: "advisory-review",
              revision: { type: "git", sha: execution.commit },
              note: text(execution.summary, "Advisory review finished."),
            },
          ],
          evidence,
          sourcePath: execution.sourcePath,
          scratchPath: execution.scratchPath,
        },
      },
      `agy-review-${input.taskId}-${generation}`,
      input.taskId,
      current.ledger,
    );
    if (recorded._tag === "Applied") current = recorded;
    if (current.state.phase !== "executing") return current;

    const run = current.state.run;
    if (execution.status === "model_mismatch") {
      const actual = execution.actualModel ?? "an unreported model";
      return yield* applyBoardWorkflowEvent(
        current.state,
        {
          type: "fail",
          failure: {
            taskId: input.taskId,
            attemptId,
            generation: run.generation,
            leaseId: run.leaseId,
            blocker: {
              summary: text(
                `Antigravity ran ${actual}, not the requested ${execution.requestedModel}.`,
                "Antigravity ran a different model than requested.",
              ),
              ownerId: input.workerId,
              nextAction: "Choose a model the CLI will run, then start the review again.",
            },
          },
        },
        `agy-fail-${input.taskId}-${generation}`,
        input.taskId,
        current.ledger,
      );
    }
    return yield* applyBoardWorkflowEvent(
      current.state,
      {
        type: "deliver_review",
        generation: run.generation,
        leaseId: run.leaseId,
      },
      `agy-done-${input.taskId}-${generation}`,
      input.taskId,
      current.ledger,
    );
  });

/** Record a stop after the card is already executing. */
export const applyAdvisoryStop = (input: {
  readonly state: SequenceState;
  readonly taskId: string;
  readonly ledger: KanbanMoveLedger;
  readonly execution: Exclude<AdvisoryExecution, AdvisorySuccess>;
  readonly workerId: string;
}): Effect.Effect<KanbanMoveResult> =>
  Effect.gen(function* () {
    if (input.state.phase !== "executing") {
      return rejected("The review is no longer running.", input.state, input.ledger);
    }
    const run = input.state.run;
    const attemptId = input.state.assignment.attemptId;
    if (input.execution.status === "canceled") {
      return yield* applyBoardWorkflowEvent(
        input.state,
        {
          type: "cancel",
          command: {
            command: "cancel",
            taskId: input.taskId,
            attemptId,
            idempotencyKey: `agy-cancel-${input.taskId}-${run.generation}`,
          },
        },
        `agy-cancel-${input.taskId}-${run.generation}`,
        input.taskId,
        input.ledger,
      );
    }
    return yield* applyBoardWorkflowEvent(
      input.state,
      {
        type: "fail",
        failure: {
          taskId: input.taskId,
          attemptId,
          generation: run.generation,
          leaseId: run.leaseId,
          blocker: {
            summary: text(input.execution.detail, "The advisory review stopped."),
            ownerId: input.workerId,
            nextAction: "Choose a model and start the review again.",
          },
        },
      },
      `agy-fail-${input.taskId}-${run.generation}`,
      input.taskId,
      input.ledger,
    );
  });

const stop = (detail: string, requestedModel: string | null = null): AdvisoryExecution => ({
  status: "unavailable",
  detail,
  models: [],
  requestedModel,
  actualModel: null,
});

export const liveAntigravity = Layer.effect(
  AntigravityReviews,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const scope = yield* Effect.scope;
    const jobs = new Map<
      string,
      {
        readonly abort: AbortController;
        readonly runId: string;
        execution: AdvisoryExecution | null;
      }
    >();
    const listModels = () =>
      Effect.promise(() => listAntigravityModels({ configuredModel: configuredModel() }));
    const watch: AntigravityReviews["Service"]["watch"] = (taskId) =>
      Effect.sync(() => {
        const job = jobs.get(taskId);
        if (job === undefined) return null;
        return job.execution === null
          ? { status: "running" as const }
          : { status: "settled" as const, execution: job.execution };
      });
    const cancel: AntigravityReviews["Service"]["cancel"] = (taskId) =>
      Effect.sync(() => {
        const job = jobs.get(taskId);
        if (job === undefined || job.execution !== null) return "already_stopped" as const;
        job.abort.abort();
        return "requested" as const;
      });
    const start: AntigravityReviews["Service"]["start"] = (input) =>
      Effect.gen(function* () {
        const current = jobs.get(input.taskId);
        if (current !== undefined && current.execution === null) {
          return { status: "running" as const, runId: current.runId };
        }
        const workspace = yield* projects.get(ProjectId.make(input.projectId)).pipe(
          Effect.map((row) => (Option.isSome(row) ? row.value.workspaceRoot : null)),
          Effect.orElseSucceed(() => null),
        );
        if (workspace === null) {
          return {
            status: "unavailable" as const,
            detail: "This project has no workspace on this server.",
            models: [] as readonly string[],
          };
        }
        const catalog = yield* Effect.promise(() =>
          listAntigravityModels({ configuredModel: configuredModel() }),
        );
        const choice = resolveModelChoice({
          discovered: catalog.source === "cli" ? catalog.models : null,
          requested: input.requestedModel,
          configured: configuredModel(),
        });
        if (!choice.ok) {
          return { status: "unavailable" as const, detail: choice.detail, models: choice.models };
        }
        const runId = `agy-${input.taskId}-${input.generation}`;
        const job = {
          abort: new AbortController(),
          runId,
          execution: null as AdvisoryExecution | null,
        };
        jobs.set(input.taskId, job);
        const isolationRoot = path.join(
          config.stateDir,
          "antigravity",
          input.taskId,
          String(input.generation),
          runId,
        );
        yield* Effect.forkIn(
          Effect.callback<void>((resume, signal) => {
            const abort = () => job.abort.abort();
            signal.addEventListener("abort", abort, { once: true });
            void runAdvisoryReview({
              repoRoot: workspace,
              isolationRoot,
              context: input.context,
              intake: input.intake,
              requestedModel: choice.slug,
              configuredModel: configuredModel(),
              signal: job.abort.signal,
            }).then(
              (execution) => {
                job.execution = execution;
                resume(Effect.void);
              },
              (error: unknown) => {
                job.execution = stop(
                  error instanceof Error
                    ? error.message
                    : "The Antigravity CLI could not be started.",
                  choice.slug,
                );
                resume(Effect.void);
              },
            );
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }),
          scope,
        );
        return { status: "running" as const, runId };
      });
    return { listModels, start, watch, cancel };
  }),
);
