import {
  advisoryUsage,
  listAntigravityModels,
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
    readonly review: (input: {
      readonly projectId: string;
      readonly taskId: string;
      readonly generation: number;
      readonly intake: Intake;
      readonly context: ContextPackageSnapshotV1;
      readonly requestedModel: string | undefined;
    }) => Effect.Effect<AdvisoryExecution>;
  }
>()("t3/aiOsAntigravity/AntigravityReviews") {}

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

const completionEvidence = (
  items: ReadonlyArray<{
    readonly kind: "commit" | "readback";
    readonly ref: string;
  }>,
):
  | readonly [
      { readonly kind: "commit" | "readback"; readonly ref: string },
      ...{ readonly kind: "commit" | "readback"; readonly ref: string }[],
    ]
  | null => {
  const [first, ...rest] = items;
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
    const queued =
      input.state.phase === "assigned" || input.state.phase === "rework" ? input.state : null;
    if (queued === null) {
      return rejected(
        "In Progress starts from Ready only after a worker is assigned.",
        input.state,
        input.ledger,
      );
    }
    const execution = input.execution;
    const generation = executionGeneration(queued);
    const attemptId = queued.assignment.attemptId;
    const projectId = queued.intake.projectId;
    let current: KanbanMoveResult = yield* applyBoardWorkflowEvent(
      queued,
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
    const submittedEvidence = completionEvidence(evidence);
    if (submittedEvidence === null) {
      return rejected("The review commit is not valid evidence.", current.state, current.ledger);
    }
    return yield* applyBoardWorkflowEvent(
      current.state,
      {
        type: "submit_completion",
        completion: {
          version: "v1",
          taskId: input.taskId,
          attemptId,
          generation: run.generation,
          leaseId: run.leaseId,
          claimedOutcome: text(execution.summary, "Advisory review finished."),
          artifactRevision: { type: "git", sha: execution.commit },
          evidence: submittedEvidence,
        },
      },
      `agy-done-${input.taskId}-${generation}`,
      input.taskId,
      current.ledger,
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
    const listModels = () =>
      Effect.promise(() => listAntigravityModels({ configuredModel: configuredModel() }));
    const review: AntigravityReviews["Service"]["review"] = (input) =>
      Effect.gen(function* () {
        const workspace = yield* projects.get(ProjectId.make(input.projectId)).pipe(
          Effect.map((row) => (Option.isSome(row) ? row.value.workspaceRoot : null)),
          Effect.orElseSucceed(() => null),
        );
        if (workspace === null) {
          return stop(
            "This project has no workspace on this server.",
            input.requestedModel ?? null,
          );
        }
        const isolationRoot = path.join(
          config.stateDir,
          "antigravity",
          input.taskId,
          String(input.generation),
        );
        return yield* Effect.callback<AdvisoryExecution>((resume, signal) => {
          void runAdvisoryReview({
            repoRoot: workspace,
            isolationRoot,
            context: input.context,
            intake: input.intake,
            requestedModel: input.requestedModel,
            configuredModel: configuredModel(),
            signal,
          }).then(
            (value) => resume(Effect.succeed(value)),
            (error: unknown) =>
              resume(
                Effect.succeed(
                  stop(
                    error instanceof Error
                      ? error.message
                      : "The Antigravity CLI could not be started.",
                    input.requestedModel ?? null,
                  ),
                ),
              ),
          );
        });
      });
    return { listModels, review };
  }),
);
