// @effect-diagnostics nodeBuiltinImport:off - Recovery confirms one spawned review pid and removes its worktree.
import * as NodeFSP from "node:fs/promises";

import {
  advisoryUsage,
  listAntigravityModels,
  resolveModelChoice,
  runAdvisoryReview,
  sweepAdvisoryIsolation,
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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
      readonly orientation?: readonly string[];
      readonly requestedModel: string | undefined;
    }) => Effect.Effect<AdvisoryOpen>;
    readonly watch: (taskId: string) => Effect.Effect<AdvisoryWatch | null>;
    readonly cancel: (taskId: string) => Effect.Effect<"requested" | "already_stopped">;
    readonly recover: (taskId: string) => Effect.Effect<AdvisoryRecover>;
    readonly sweep: (taskId: string) => Effect.Effect<void>;
  }
>()("t3/aiOsAntigravity/AntigravityReviews") {}

export type AdvisoryRecover = { readonly status: "still_running" } | { readonly status: "stopped" };

export type AdvisoryOpen =
  | {
      readonly status: "unavailable";
      readonly detail: string;
      readonly models: readonly string[];
    }
  | { readonly status: "running"; readonly runId: string }
  | { readonly status: "settled"; readonly runId: string; readonly execution: AdvisoryExecution };

export type AdvisoryWatch =
  | { readonly status: "running"; readonly generation?: number }
  | {
      readonly status: "settled";
      readonly execution: AdvisoryExecution;
      readonly generation?: number;
    };

const ActiveReviewFile = Schema.Struct({
  pid: Schema.NullOr(Schema.Number),
  isolationRoot: Schema.String.check(Schema.isMinLength(1)),
  generation: Schema.Number,
  // Absent on markers written before the server-start cutoff existed.
  writtenAt: Schema.optional(Schema.Number),
  bootId: Schema.optional(Schema.NullOr(Schema.String)),
  startTicks: Schema.optional(Schema.NullOr(Schema.String)),
});
type ActiveReview = typeof ActiveReviewFile.Type;

export interface ProcessIdentity {
  readonly bootId: string;
  readonly startTicks: string;
}

/** Field 22 of /proc/pid/stat, the start time in clock ticks since boot. */
export const startTicksOf = (stat: string): string | null => {
  const end = stat.lastIndexOf(")");
  if (end < 0) return null;
  const ticks = stat.slice(end + 2).split(" ")[19];
  return ticks !== undefined && /^[0-9]+$/.test(ticks) ? ticks : null;
};

export const readProcessIdentity = async (pid: number): Promise<ProcessIdentity | null> => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const bootId = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const ticks = startTicksOf(await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8"));
    if (bootId.length === 0 || ticks === null) return null;
    return { bootId, startTicks: ticks };
  } catch {
    return null;
  }
};

const sameProcess = (marker: ActiveReview, live: ProcessIdentity | null): boolean =>
  live !== null &&
  marker.bootId != null &&
  marker.startTicks != null &&
  marker.bootId === live.bootId &&
  marker.startTicks === live.startTicks;

/** A live pid is signaled only when the marker's boot id and start time still match. */
export const confirmedReviewPid = (
  marker: ActiveReview,
  live: ProcessIdentity | null,
  alive: boolean,
): number | null => {
  if (marker.pid === null || marker.pid === process.pid || !alive) return null;
  return sameProcess(marker, live) ? marker.pid : null;
};

interface AntigravityDeps {
  readonly runReview?: typeof runAdvisoryReview;
  readonly readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  readonly pidAlive?: (pid: number) => boolean;
  readonly signal?: (pid: number) => void;
  readonly listModels?: () => Promise<AntigravityCatalog>;
}

const decodeActiveReviewFile = Schema.decodeUnknownSync(Schema.fromJsonString(ActiveReviewFile));
const encodeActiveReviewFile = Schema.encodeSync(Schema.fromJsonString(ActiveReviewFile));

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

export const makeAntigravityReviews = (deps: AntigravityDeps = {}) =>
  Layer.effect(
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
          readonly generation: number;
          execution: AdvisoryExecution | null;
        }
      >();
      const markerFor = (taskId: string) =>
        path.join(config.stateDir, "antigravity", taskId, "active.json");
      const readMarker = (taskId: string) =>
        Effect.promise(async (): Promise<ActiveReview | null> => {
          try {
            return decodeActiveReviewFile(await NodeFSP.readFile(markerFor(taskId), "utf8"));
          } catch {
            return null;
          }
        });
      const writeMarker = (taskId: string, marker: ActiveReview) =>
        Effect.promise(async () => {
          const file = markerFor(taskId);
          await NodeFSP.mkdir(path.dirname(file), { recursive: true });
          await NodeFSP.writeFile(file, encodeActiveReviewFile(marker));
        });
      const signalStop =
        deps.signal ??
        ((pid: number): void => {
          try {
            process.kill(pid, "SIGINT");
          } catch {
            // The pid exited between the check and the signal.
          }
        });
      const pidAlive =
        deps.pidAlive ??
        ((pid: number): boolean => {
          if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EPERM"
            );
          }
        });
      const readIdentity = deps.readIdentity ?? readProcessIdentity;
      const runReview = deps.runReview ?? runAdvisoryReview;
      const serverStartedAt = yield* Clock.currentTimeMillis;
      const releaseMarker = (taskId: string, generation: number) =>
        Effect.promise(async () => {
          try {
            const current = decodeActiveReviewFile(
              await NodeFSP.readFile(markerFor(taskId), "utf8"),
            );
            if (current.generation !== generation) return;
          } catch {
            return;
          }
          await NodeFSP.rm(markerFor(taskId), { force: true });
        });
      const isolationPresent = (root: string) =>
        Effect.promise(async () => {
          try {
            await NodeFSP.access(root);
            return true;
          } catch {
            return false;
          }
        });
      const listModels = () =>
        Effect.promise(() => listAntigravityModels({ configuredModel: configuredModel() }));
      const watch: AntigravityReviews["Service"]["watch"] = (taskId) =>
        Effect.sync(() => {
          const job = jobs.get(taskId);
          if (job === undefined) return null;
          return job.execution === null
            ? { status: "running" as const, generation: job.generation }
            : { status: "settled" as const, execution: job.execution, generation: job.generation };
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
            return {
              status: "unavailable" as const,
              detail:
                "The earlier advisory review is still running. It stays blocked until that process is confirmed stopped.",
              models: [] as readonly string[],
            };
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
            (
              deps.listModels ??
              (() => listAntigravityModels({ configuredModel: configuredModel() }))
            )(),
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
            generation: input.generation,
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
          const writtenAt = yield* Clock.currentTimeMillis;
          yield* writeMarker(input.taskId, {
            pid: null,
            isolationRoot,
            generation: input.generation,
            writtenAt,
            bootId: null,
            startTicks: null,
          });
          yield* Effect.forkIn(
            Effect.gen(function* () {
              const execution = yield* Effect.callback<AdvisoryExecution>((resume, signal) => {
                const abort = () => job.abort.abort();
                signal.addEventListener("abort", abort, { once: true });
                void runReview({
                  repoRoot: workspace,
                  isolationRoot,
                  context: input.context,
                  intake: input.intake,
                  ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
                  requestedModel: choice.slug,
                  configuredModel: configuredModel(),
                  signal: job.abort.signal,
                  onSpawn: (pid) => {
                    const writePid = (identity: { bootId: string; startTicks: string } | null) =>
                      NodeFSP.writeFile(
                        markerFor(input.taskId),
                        encodeActiveReviewFile({
                          pid,
                          isolationRoot,
                          generation: input.generation,
                          writtenAt,
                          bootId: identity?.bootId ?? null,
                          startTicks: identity?.startTicks ?? null,
                        }),
                      ).catch(() => undefined);
                    if (pid === null) {
                      void writePid(null);
                      return;
                    }
                    void readIdentity(pid).then(writePid);
                  },
                }).then(
                  (value) => resume(Effect.succeed(value)),
                  (error: unknown) =>
                    resume(
                      Effect.succeed(
                        stop(
                          error instanceof Error
                            ? error.message
                            : "The Antigravity CLI could not be started.",
                          choice.slug,
                        ),
                      ),
                    ),
                );
                return Effect.sync(() => signal.removeEventListener("abort", abort));
              });
              if (jobs.get(input.taskId) === job) job.execution = execution;
              yield* releaseMarker(input.taskId, input.generation);
            }),
            scope,
          );
          return { status: "running" as const, runId };
        });
      const recover: AntigravityReviews["Service"]["recover"] = (taskId) =>
        Effect.gen(function* () {
          const job = jobs.get(taskId);
          if (job !== undefined && job.execution === null) {
            job.abort.abort();
            return { status: "still_running" as const };
          }
          const marker = yield* readMarker(taskId);
          if (job !== undefined && job.execution !== null) {
            if (marker !== null) {
              yield* Effect.promise(() => sweepAdvisoryIsolation({ root: marker.isolationRoot }));
              yield* Effect.promise(() => NodeFSP.rm(markerFor(taskId), { force: true }));
            }
            jobs.delete(taskId);
            return { status: "stopped" as const };
          }
          if (marker === null) return { status: "stopped" as const };
          if (marker.pid === process.pid) return { status: "still_running" as const };
          if (marker.pid === null) {
            const fresh = marker.writtenAt !== undefined && marker.writtenAt >= serverStartedAt;
            if (fresh) return { status: "still_running" as const };
            const present = yield* isolationPresent(marker.isolationRoot);
            if (present) {
              yield* Effect.promise(() =>
                sweepAdvisoryIsolation({ root: marker.isolationRoot, pid: null }),
              );
            }
            yield* Effect.promise(() => NodeFSP.rm(markerFor(taskId), { force: true }));
            return { status: "stopped" as const };
          }
          const alive = pidAlive(marker.pid);
          if (!alive) {
            yield* Effect.promise(() =>
              sweepAdvisoryIsolation({ root: marker.isolationRoot, pid: null }),
            );
            yield* Effect.promise(() => NodeFSP.rm(markerFor(taskId), { force: true }));
            return { status: "stopped" as const };
          }
          const live = yield* Effect.promise(() => readIdentity(marker.pid ?? -1));
          // Unreadable /proc, or a marker that never stored boot id and start ticks.
          // A live pid in that state is still the review. Do not signal it or delete its marker.
          if (live === null || marker.bootId == null || marker.startTicks == null) {
            return { status: "still_running" as const };
          }
          if (!sameProcess(marker, live)) {
            yield* Effect.promise(() =>
              sweepAdvisoryIsolation({ root: marker.isolationRoot, pid: null }),
            );
            yield* Effect.promise(() => NodeFSP.rm(markerFor(taskId), { force: true }));
            return { status: "stopped" as const };
          }
          const again = yield* Effect.promise(() => readIdentity(marker.pid ?? -1));
          if (again === null) return { status: "still_running" as const };
          if (!sameProcess(marker, again)) {
            yield* Effect.promise(() =>
              sweepAdvisoryIsolation({ root: marker.isolationRoot, pid: null }),
            );
            yield* Effect.promise(() => NodeFSP.rm(markerFor(taskId), { force: true }));
            return { status: "stopped" as const };
          }
          signalStop(marker.pid);
          return { status: "still_running" as const };
        });
      const sweep: AntigravityReviews["Service"]["sweep"] = (taskId) =>
        Effect.gen(function* () {
          const job = jobs.get(taskId);
          if (job !== undefined && job.execution === null) return;
          const marker = yield* readMarker(taskId);
          const root = marker?.isolationRoot ?? path.join(config.stateDir, "antigravity", taskId);
          const alive = marker?.pid != null && pidAlive(marker.pid);
          const live =
            marker?.pid != null && alive
              ? yield* Effect.promise(() => readIdentity(marker.pid ?? -1))
              : null;
          if (alive && (live === null || marker?.bootId == null || marker?.startTicks == null)) {
            return;
          }
          const pid = marker === null ? null : confirmedReviewPid(marker, live, alive);
          const cleaned = yield* Effect.promise(() => sweepAdvisoryIsolation({ root, pid }));
          if (!cleaned) return;
          yield* Effect.promise(() => NodeFSP.rm(markerFor(taskId), { force: true }));
          if (job !== undefined) jobs.delete(taskId);
        });
      const stored = yield* Effect.promise(async () => {
        try {
          return await NodeFSP.readdir(path.join(config.stateDir, "antigravity"));
        } catch {
          return [] as string[];
        }
      });
      for (const taskId of stored) yield* sweep(taskId);
      return { listModels, start, watch, cancel, recover, sweep };
    }),
  );

export const liveAntigravity = makeAntigravityReviews();
