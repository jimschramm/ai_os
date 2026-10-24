// @effect-diagnostics nodeBuiltinImport:off - The production memory file is under the home directory, and tests keep theirs in the temp state dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import {
  ADAPTER_ANTIGRAVITY_MODELS_PATH,
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_MOVE_PATH,
  ADAPTER_BOARD_PATH,
  ADAPTER_MEMORY_COMMIT_PATH,
  ADAPTER_MEMORY_RESOLVE_PATH,
  ADAPTER_MEMORY_SUPPLY_PATH,
  ADAPTER_MEMORY_WRITE_PATH,
  ADAPTER_REQUEST_PATH,
  ADAPTER_ROLES_PATH,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import {
  decodeAdapterBoardWire,
  encodeAdapterBoardWire,
  makeAdapterBoardHub,
} from "@t3tools/ai-os-adapter/board-hub";
import {
  AWAITING_IMPLEMENTER_MODEL,
  antigravitySupports,
  launchCommandId,
  observationEvents,
  renderSuppliedPrompt,
  T3_LAUNCH_DEFAULTS,
  threadViewFromProjection,
  type T3ThreadView,
} from "@t3tools/ai-os-adapter";
import {
  applyBoardWorkflowEvent,
  canonicalGitSha,
  commitInterruptedMove,
  ContractId,
  ContractText,
  declaredTaskType,
  decodeAssignmentV1,
  decodeQaVerdictV1,
  decodeRoleDefaultsFile,
  decodeSequenceEvent,
  decodeSequenceState,
  eligibleImplementer,
  executionGeneration,
  executionLaunchKey,
  GitSha,
  Intake,
  ContractTransitionError,
  needsWorkerNotice,
  QA_INCOMPLETE_LABEL,
  openBoardTask,
  initialMemoryLedger,
  launchMemoryLines,
  promptCarriesMemory,
  qaWorkerFor,
  recordPendingVerdict,
  requestKanbanMove,
  reviewSteward,
  RoleWorkerV1,
  runtimeForAssignment,
  sameBaseModel,
  sameModelName,
  SequenceState,
  type RoleDefaultsFileV1,
  type AttemptMemoryActivityV1,
  type ContextPackageSnapshotV1,
  type PreparedTaskMemory,
  type SequenceEvent,
  type KanbanColumn,
  type KanbanMoveLedger,
  type KanbanMoveResult,
} from "@t3tools/ai-os-contracts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  MessageId,
  OrchestrationMessageContext,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";

import {
  AntigravityReviews,
  applyAdvisoryExecution,
  applyAdvisoryStop,
  type AdvisoryOpen,
} from "./aiOsAntigravity.ts";
import { memoryDatabasePath, openMemoryDatabase, readMemoryLedger } from "./aiOsMemory.ts";
import { resolveMemoryConflictSync } from "./aiOsSteward.ts";
import {
  attemptWriteTokenSync,
  commitLaunchReadSync,
  commitTaskReadSync,
  prepareTaskMemorySync,
  readAttemptActivitySync,
  recordTaskWriteSync,
  submitAttemptMemorySync,
  supplyLaunchReadSync,
  withTaskMemory,
} from "./aiOsTaskMemory.ts";
import type { AdvisoryExecution, AdvisorySuccess } from "@t3tools/ai-os-adapter";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "./auth/http.ts";
import * as ServerConfig from "./config.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";

const BOARD_FILE = "ai-os-board.json";
const RolePost = Schema.Struct({
  projectId: ContractId,
  implementer: Schema.optionalKey(RoleWorkerV1),
  qa: Schema.optionalKey(RoleWorkerV1),
});
const RequestPost = Schema.Struct({
  taskId: ContractId,
  title: ContractText,
  idempotencyKey: ContractId,
  repoCommit: GitSha,
  intake: Intake,
});
const decodeRolePost = Schema.decodeUnknownEffect(RolePost, { onExcessProperty: "error" });
const decodeRequestPost = Schema.decodeUnknownEffect(RequestPost, { onExcessProperty: "error" });
const BOARD_FOLLOW_INTERVAL = "1 second";
const COLUMNS = ["Backlog", "Ready", "Running", "Review", "Blocked", "Done"] as const;

type BoardSequence = SequenceState;

const LedgerSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    column: Schema.Literals(["Backlog", "Ready", "Running", "Review", "Blocked", "Done"]),
    taskId: Schema.String,
    state: SequenceState,
  }),
);
const decodeLedger = Schema.decodeUnknownSync(LedgerSchema);

export class BoardRunError extends Data.TaggedError("BoardRunError")<{
  readonly detail: string;
}> {}

export type BoardInterruptConfirmation = "requested" | "already_stopped";

export type BoardLaunchDisposition = "active" | "completed" | "failed";

export interface BoardLaunchResult {
  readonly threadId: string;
  readonly runId: string | null;
  readonly disposition: BoardLaunchDisposition;
  readonly summary: string | null;
}

/**
 * The board asks the orchestration runtime before it records a run phase.
 * Tests substitute this. Production uses the live thread service.
 */
export class BoardRuns extends Context.Service<
  BoardRuns,
  {
    readonly interrupt: (input: {
      readonly projectId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly commandId: string;
    }) => Effect.Effect<BoardInterruptConfirmation, BoardRunError>;
    readonly confirmLaunch: (input: {
      readonly projectId: string;
      readonly threadId: string;
      readonly runId: string;
    }) => Effect.Effect<"active" | "settled", BoardRunError>;
    readonly launch: (input: {
      readonly idempotencyKey: string;
      readonly projectId: string;
      readonly title: string;
      readonly prompt: string;
      readonly model: string;
      readonly instanceId: string;
      readonly contextPackage: ContextPackageSnapshotV1;
    }) => Effect.Effect<BoardLaunchResult, BoardRunError>;
    readonly continueRun: (input: {
      readonly projectId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly commandId: string;
      readonly messageId: string;
      readonly text: string;
    }) => Effect.Effect<{ readonly runId: string | null }, BoardRunError>;
    readonly watchThread: (threadId: string) => Effect.Effect<T3ThreadView | null, BoardRunError>;
    /**
     * The submitting QA session. A null view is unverifiable: no actual is recorded,
     * and the verdict cannot become rework or accept.
     */
    readonly readReviewerSession: (input: {
      readonly threadId: string | null;
      readonly runId: string | null;
    }) => Effect.Effect<T3ThreadView | null, BoardRunError>;
    /** Production follows launched runs. Tests leave this off so a tick cannot race the assertion. */
    readonly followRuns: boolean;
  }
>()("t3/aiOsBoard/BoardRuns") {}

const runError = (detail: string) => new BoardRunError({ detail });

const INTERRUPT_UNCONFIRMED = "The run did not confirm the interrupt.";

const NOT_ACTIVE = "That run is not active, so the board will not mark it in progress.";

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

const launchContext = (contextPackage: ContextPackageSnapshotV1) =>
  decodeMessageContext({
    version: 1,
    records: [
      {
        version: 1,
        contextId: "context-package",
        label: "Context package",
        kind: "context-package",
        payload: contextPackage,
      },
    ],
  });

const errorDetail = (error: unknown, fallback: string): string =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string" &&
  error.message.length > 0
    ? error.message
    : fallback;

export const liveRuns = Layer.effect(
  BoardRuns,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const interrupt: BoardRuns["Service"]["interrupt"] = (input) =>
      threads
        .interruptThread({
          projectId: ProjectId.make(input.projectId),
          commandId: CommandId.make(input.commandId),
          threadId: ThreadId.make(input.threadId),
          runId: RunId.make(input.runId),
          reason: "Operations board",
        })
        .pipe(
          Effect.flatMap((result) => {
            if (result.type === "interrupt_requested") return Effect.succeed("requested" as const);
            if (result.type === "already_terminal") {
              return Effect.succeed("already_stopped" as const);
            }
            return Effect.fail(runError(INTERRUPT_UNCONFIRMED));
          }),
          Effect.mapError((error) =>
            error instanceof BoardRunError ? error : runError(INTERRUPT_UNCONFIRMED),
          ),
        );
    const confirmLaunch: BoardRuns["Service"]["confirmLaunch"] = (input) =>
      threads.getThreadShell(ThreadId.make(input.threadId)).pipe(
        Effect.mapError(() => runError(NOT_ACTIVE)),
        Effect.flatMap((shell) => {
          if (shell === null) return Effect.fail(runError(NOT_ACTIVE));
          if (shell.projectId !== ProjectId.make(input.projectId)) {
            return Effect.fail(runError("The run belongs to a different project."));
          }
          const runId = RunId.make(input.runId);
          if (shell.activeRunId === runId) return Effect.succeed("active" as const);
          if (shell.activeRunId === null && shell.latestRunId === runId) {
            return Effect.succeed("settled" as const);
          }
          return Effect.fail(runError(NOT_ACTIVE));
        }),
      );
    const launch: BoardRuns["Service"]["launch"] = (input) =>
      launches
        .launch({
          commandId: CommandId.make(launchCommandId(input.idempotencyKey)),
          projectId: ProjectId.make(input.projectId),
          title: input.title,
          modelSelection: {
            instanceId: ProviderInstanceId.make(input.instanceId),
            model: input.model,
          },
          runtimeMode: T3_LAUNCH_DEFAULTS.runtimeMode,
          interactionMode: T3_LAUNCH_DEFAULTS.interactionMode,
          workspaceStrategy: T3_LAUNCH_DEFAULTS.workspaceStrategy,
          initialMessage: {
            text: input.prompt,
            attachments: [],
            context: launchContext(input.contextPackage),
          },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.map((result) => {
            const run = result.projection.runs.at(-1);
            const status = run?.status;
            const assistant = result.projection.messages.findLast(
              (message) => message.role === "assistant" && message.text.length > 0,
            );
            const disposition: BoardLaunchDisposition =
              status === "completed" ? "completed" : status === "failed" ? "failed" : "active";
            return {
              threadId: result.threadId,
              runId: run?.id ?? null,
              disposition,
              summary: assistant?.text ?? null,
            };
          }),
          Effect.mapError((error) => runError(errorDetail(error, "The run did not launch."))),
        );
    const continueRun: BoardRuns["Service"]["continueRun"] = (input) =>
      threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(input.commandId),
          createdBy: "user",
          creationSource: "web",
          threadId: ThreadId.make(input.threadId),
          messageId: MessageId.make(input.messageId),
          text: input.text,
          attachments: [],
          manualContinuationOfRunId: RunId.make(input.runId),
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(
          Effect.andThen(threads.getThreadProjection(ThreadId.make(input.threadId))),
          Effect.map((projection) => ({ runId: projection.runs.at(-1)?.id ?? null })),
          Effect.mapError((error) => runError(errorDetail(error, "The run did not continue."))),
        );
    const watchThread: BoardRuns["Service"]["watchThread"] = (threadId) =>
      threads.getThreadProjection(ThreadId.make(threadId)).pipe(
        Effect.map((projection) => threadViewFromProjection(threadId, projection)),
        Effect.mapError((error) => runError(errorDetail(error, "The thread could not be read."))),
      );
    const readReviewerSession: BoardRuns["Service"]["readReviewerSession"] = (input) =>
      Effect.gen(function* () {
        const namedThread =
          input.threadId !== null && input.threadId.length > 0 ? input.threadId : null;
        const namedRun = input.runId !== null && input.runId.length > 0 ? input.runId : null;
        if (namedThread === null && namedRun === null) return null;
        let resolved = namedThread;
        if (resolved === null && namedRun !== null) {
          const snapshot = yield* threads.getShellSnapshot();
          const wanted = RunId.make(namedRun);
          const shell = [...snapshot.threads, ...snapshot.archivedThreads].find(
            (item) => item.latestRunId === wanted || item.activeRunId === wanted,
          );
          resolved = shell?.id ?? null;
        }
        if (resolved === null) return null;
        const view = yield* watchThread(resolved);
        if (view === null) return null;
        if (namedRun !== null && view.runId !== namedRun) return null;
        return view;
      }).pipe(Effect.catch(() => Effect.succeed(null)));
    return {
      interrupt,
      confirmLaunch,
      launch,
      continueRun,
      watchThread,
      readReviewerSession,
      followRuns: true,
    };
  }),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isColumn = (value: unknown): value is KanbanColumn =>
  typeof value === "string" && (COLUMNS as readonly string[]).includes(value);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.text(encodeJson(body), {
    status,
    contentType: "application/json",
  });

const readJson = (text: string): unknown => {
  try {
    return decodeJson(text);
  } catch {
    return null;
  }
};

const ledgerFrom = (value: unknown): KanbanMoveLedger => {
  try {
    return decodeLedger(value);
  } catch {
    return {};
  }
};

const stringField = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null;

const stamped = Effect.map(DateTime.now, DateTime.formatIso);

const projectIdOf = (state: BoardSequence): string | null =>
  "intake" in state ? state.intake.projectId : null;

const claimText = (value: string | null, fallback: string): string => {
  const trimmed = (value ?? "").trim().slice(0, 8_000);
  return trimmed.length > 0 ? trimmed : fallback;
};

const evidenceRef = (threadId: string): string => {
  const ref = `thread:${threadId}`;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref) && ref.length <= 128 ? ref : "thread:t3";
};

const taskMemoryFile = (stateDir: string): string =>
  process.env.VITEST === "true" || process.env.NODE_ENV === "test"
    ? `${stateDir}/memory.db`
    : memoryDatabasePath(process.env, NodeOS.homedir());

const memoryRequest = (state: BoardSequence, createdAt: string) => {
  if (!("assignment" in state)) return null;
  const projectId = projectIdOf(state);
  if (projectId === null) return null;
  return {
    projectId,
    taskId: state.assignment.taskId,
    attemptId: state.assignment.attemptId,
    authorId: state.assignment.workerId,
    runtime: runtimeForAssignment(state.assignment),
    repoCommit: state.assignment.contextPackage.repoCommit,
    requirements: state.assignment.contextPackage.requirements,
    authorizationScope: state.assignment.contextPackage.authorizationScope,
    createdAt,
  };
};

const readBoardMemory = (
  file: string,
): {
  readonly activity: readonly AttemptMemoryActivityV1[];
  readonly ledger: typeof initialMemoryLedger;
} => {
  try {
    const database = openMemoryDatabase(file);
    try {
      return { activity: readAttemptActivitySync(database), ledger: readMemoryLedger(database) };
    } finally {
      database.close();
    }
  } catch {
    return { activity: [], ledger: initialMemoryLedger };
  }
};

/**
 * Build the package and the prompt that carries it. Nothing is written here.
 * The read receipt is stored only after the adapter accepts this prompt.
 */
const suppliedForLaunch = (file: string, state: BoardSequence) =>
  Effect.gen(function* () {
    if (!("assignment" in state) || !("intake" in state)) {
      return yield* new ContractTransitionError({
        contract: "memory",
        reason: "invalid_payload",
        from: "idle",
        event: "submit",
        detail: "This run has no assignment.",
      });
    }
    const request = memoryRequest(state, DateTime.formatIso(yield* DateTime.now));
    if (request === null) {
      return yield* new ContractTransitionError({
        contract: "memory",
        reason: "invalid_payload",
        from: "idle",
        event: "submit",
        detail: "This run has no project.",
      });
    }
    const supplied = yield* withTaskMemory(file, (database) => {
      const prepared = prepareTaskMemorySync(database, request);
      return {
        prepared,
        writeToken: attemptWriteTokenSync(database, prepared.receipt.attemptId),
      };
    });
    const lines = launchMemoryLines(
      supplied.prepared.package,
      ADAPTER_MEMORY_WRITE_PATH,
      supplied.writeToken,
    );
    const prompt = renderSuppliedPrompt(state.intake, supplied.prepared.contextPackage, lines);
    if (
      !promptCarriesMemory(supplied.prepared.package, prompt) ||
      !prompt.includes(ADAPTER_MEMORY_WRITE_PATH) ||
      !prompt.includes(supplied.writeToken)
    ) {
      return yield* new ContractTransitionError({
        contract: "memory",
        reason: "invalid_payload",
        from: "idle",
        event: "submit",
        detail: "The launch prompt does not include the memory package.",
      });
    }
    return { prepared: supplied.prepared, prompt, lines, writeToken: supplied.writeToken };
  });

/** Store the read after the adapter has accepted the prompt that carries this package. */
const commitSuppliedRead = (file: string, prepared: PreparedTaskMemory, writeToken: string) =>
  withTaskMemory(file, (database) => commitTaskReadSync(database, prepared, writeToken)).pipe(
    Effect.map(() => ({ _tag: "Ok" as const })),
    Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
  );

const rememberExplanation = (
  file: string,
  state: BoardSequence,
  explanation: string,
  evidenceId: string,
) =>
  withTaskMemory(file, (database) => {
    if (!("assignment" in state)) return;
    const attemptId = state.assignment.attemptId;
    const existing = readAttemptActivitySync(database).find((item) => item.attemptId === attemptId);
    if (existing === undefined || existing.write !== null) return;
    recordTaskWriteSync(
      database,
      attemptId,
      {
        kind: "no_durable_change",
        explanation: claimText(explanation, "The run recorded no durable memory change."),
        evidence: [{ evidenceId, note: "Recorded when the run finished." }],
      },
      "jim",
    );
  });

const rejectedMove = (
  detail: string,
  state: BoardSequence,
  ledger: KanbanMoveLedger,
): KanbanMoveResult => ({ _tag: "Rejected", detail, state, ledger });

const gitArtifact = (
  revision: string | null | undefined,
): { readonly type: "git"; readonly sha: string } | null => {
  const sha = canonicalGitSha(revision ?? "");
  return sha === null ? null : { type: "git", sha };
};

/** A checkpoint ref is `refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/<n>`. */
const CHECKPOINT_REF = /^refs\/t3\/orchestration-v2\/checkpoints\/[A-Za-z0-9_-]+\/ordinal\/[0-9]+$/;

/**
 * The live thread reports a checkpoint ref, not the commit it names.
 * QA is bound to that commit, so the ref is resolved before completion is stored.
 */
const commitShaForRevision = (
  revision: string | null | undefined,
  cwd: string | null | undefined,
): string | null => {
  const direct = canonicalGitSha(revision ?? "");
  if (direct !== null) return direct;
  if (revision == null || cwd == null || cwd.length === 0 || !CHECKPOINT_REF.test(revision)) {
    return null;
  }
  try {
    const sha = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--verify", `${revision}^{commit}`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return canonicalGitSha(sha);
  } catch {
    return null;
  }
};

const withResolvedRevision = (view: T3ThreadView): T3ThreadView => {
  const sha = commitShaForRevision(view.revision, view.cwd);
  if (sha === null || sha === view.revision) return view;
  return { ...view, revision: sha };
};

/**
 * Record start, then a terminal outcome when the run already finished.
 * The card leaves Ready only after both events apply, in that order.
 */
const recordConfirmedRun = (input: {
  readonly state: BoardSequence;
  readonly taskId: string;
  readonly threadId: string;
  readonly disposition: BoardLaunchDisposition;
  readonly summary: string | null;
  readonly ledger: KanbanMoveLedger;
  readonly memoryFile: string;
  /** Model the run was asked to use. Null when the thread did not report one. */
  readonly implementerRequested?: string | null;
  /** Provider-reported model. A finished run without one is not submitted for QA. */
  readonly implementerActual?: string | null;
  /** Provider revision. A full git id is the submitted commit. Anything else stays a named page. */
  readonly revision?: string | null;
}): Effect.Effect<KanbanMoveResult> =>
  Effect.gen(function* () {
    const queued =
      input.state.phase === "assigned" || input.state.phase === "rework" ? input.state : null;
    if (queued === null) {
      return rejectedMove(
        "In Progress starts from Ready only after a worker is assigned.",
        input.state,
        input.ledger,
      );
    }
    const generation =
      queued.phase === "assigned" ? queued.nextGeneration : queued.run.generation + 1;
    const attemptId = queued.assignment.attemptId;
    const started = yield* applyBoardWorkflowEvent(
      queued,
      { type: "start_execution" },
      `start-${input.taskId}-${generation}`,
      input.taskId,
      input.ledger,
    );
    if (started._tag !== "Applied" || started.state.phase !== "executing") return started;
    if (input.disposition === "active") return started;
    const run = started.state.run;
    const requestedText = input.implementerRequested?.trim() ?? "";
    const actualText = input.implementerActual?.trim() ?? "";
    const requested = requestedText.length > 0 ? { model: requestedText } : null;
    const actual = actualText.length > 0 ? { model: actualText } : null;
    const recorded =
      input.disposition === "completed" && (requested !== null || actual !== null)
        ? yield* applyBoardWorkflowEvent(
            started.state,
            {
              type: "record_runtime_models",
              taskId: input.taskId,
              attemptId,
              generation: run.generation,
              leaseId: run.leaseId,
              role: "implementer",
              requested,
              actual,
            },
            `runtime-${input.taskId}-${run.generation}-implementer`,
            input.taskId,
            started.ledger,
          )
        : started;
    if (recorded._tag !== "Applied" || recorded.state.phase !== "executing") return recorded;
    if (input.disposition === "completed" && actual !== null) {
      const wrote = yield* rememberExplanation(
        input.memoryFile,
        recorded.state,
        claimText(input.summary, "The run finished."),
        evidenceRef(input.threadId),
      ).pipe(
        Effect.map(() => ({ _tag: "Ok" as const })),
        Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
      );
      if (wrote._tag === "No") return rejectedMove(wrote.detail, recorded.state, recorded.ledger);
    }
    if (input.disposition === "completed" && actual === null) {
      return yield* applyBoardWorkflowEvent(
        recorded.state,
        {
          type: "report_progress",
          report: {
            version: "v1",
            taskId: input.taskId,
            attemptId,
            generation: run.generation,
            leaseId: run.leaseId,
            status: "blocked",
            blockers: [
              {
                summary: AWAITING_IMPLEMENTER_MODEL,
                ownerId: queued.assignment.workerId,
                nextAction:
                  "Wait until the provider reports the model that ran. This run stays out of QA.",
              },
            ],
            partialArtifacts: [],
          },
        },
        `await-model-${input.taskId}-${run.generation}`,
        input.taskId,
        recorded.ledger,
      );
    }
    const terminal =
      input.disposition === "completed"
        ? yield* applyBoardWorkflowEvent(
            recorded.state,
            {
              type: "submit_completion",
              completion: {
                version: "v1",
                taskId: input.taskId,
                attemptId,
                generation: run.generation,
                leaseId: run.leaseId,
                claimedOutcome: claimText(input.summary, "The run finished."),
                artifactRevision: gitArtifact(input.revision) ?? {
                  type: "named",
                  kind: "page",
                  id: "t3-result",
                },
                evidence: [{ kind: "readback", ref: evidenceRef(input.threadId) }],
              },
            },
            `complete-${input.taskId}-${run.generation}`,
            input.taskId,
            recorded.ledger,
          )
        : yield* applyBoardWorkflowEvent(
            started.state,
            {
              type: "fail",
              failure: {
                taskId: input.taskId,
                attemptId,
                generation: run.generation,
                leaseId: run.leaseId,
                blocker: {
                  summary: claimText(input.summary, "The run failed."),
                  ownerId: queued.assignment.workerId,
                  nextAction: "Review the thread, then retry or reassign the task.",
                },
              },
            },
            `fail-${input.taskId}-${run.generation}`,
            input.taskId,
            started.ledger,
          );
    return terminal._tag === "Applied" ? terminal : recorded;
  });

const publicMove = (result: KanbanMoveResult) =>
  result._tag === "Applied"
    ? { _tag: "Applied" as const, changed: result.changed }
    : { _tag: result._tag, detail: result.detail };

const decodeState = (value: unknown) =>
  decodeSequenceState(value).pipe(
    Effect.map((state) => ({ _tag: "Ok" as const, state })),
    Effect.catchTags({
      SchemaError: () => Effect.succeed({ _tag: "Bad" as const }),
    }),
  );

const decodeEvent = (value: unknown) =>
  decodeSequenceEvent(value).pipe(
    Effect.map((event) => ({ _tag: "Ok" as const, event })),
    Effect.catchTags({
      SchemaError: () => Effect.succeed({ _tag: "Bad" as const }),
    }),
  );

const authorize = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

const authResponse = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const asRun = <A>(effect: Effect.Effect<A, BoardRunError>) =>
  effect.pipe(
    Effect.map((value) => ({ _tag: "Ok" as const, value })),
    Effect.catchTags({
      BoardRunError: (error) => Effect.succeed({ _tag: "No" as const, detail: error.detail }),
    }),
  );

/**
 * Board snapshot on the T3 HTTP server, so the web app uses the same origin and
 * the same session as every other API call.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runs = yield* BoardRuns;
    const reviews = yield* AntigravityReviews;
    const filePath = path.join(config.stateDir, BOARD_FILE);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);
    const hub = makeAdapterBoardHub();
    let publishAttempts: () => void = () => undefined;
    const existing = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    let ledger: KanbanMoveLedger = {};
    if (existing.length > 0) {
      const parsed = readJson(existing);
      if (Array.isArray(parsed)) {
        hub.replace(existing);
      } else if (
        isRecord(parsed) &&
        Array.isArray(parsed.cards) &&
        hub.replace(encodeJson(parsed.cards))
      ) {
        if (isRecord(parsed.ledger)) {
          ledger = ledgerFrom(parsed.ledger);
        }
      }
    }
    const writes = yield* Semaphore.make(1);
    const envelope = () => encodeJson({ cards: readJson(hub.snapshot()), ledger });
    const persist = (body: string) =>
      Effect.gen(function* () {
        const temporary = `${filePath}.${yield* crypto.randomUUIDv4()}.tmp`;
        yield* fs
          .writeFileString(temporary, body)
          .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
        yield* fs
          .rename(temporary, filePath)
          .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
      });
    const snapshot = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      publishAttempts();
      return HttpServerResponse.text(hub.snapshot(), { contentType: "application/json" });
    }).pipe(Effect.catchTags(authResponse));
    const replace = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const previous = hub.snapshot();
          const written = hub.upsert(text);
          if (written === "invalid")
            return HttpServerResponse.text("Invalid board.", { status: 400 });
          if (written === "stale") {
            return json(409, {
              detail: "The board changed since this snapshot. The server kept its copy.",
            });
          }
          if (written === "forbidden") {
            return json(409, {
              detail: "State changes go through the workflow. The snapshot was not stored.",
            });
          }
          yield* persist(envelope()).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                hub.replace(previous);
              }),
            ),
          );
          publishAttempts();
          return HttpServerResponse.text(hub.snapshot(), {
            status: 200,
            contentType: "application/json",
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const events = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      publishAttempts();
      return yield* hub.events;
    }).pipe(Effect.catchTags(authResponse));
    const cardsNow = () => decodeAdapterBoardWire(hub.snapshot()) ?? [];
    const withAttempts = (cards: readonly AdapterBoardCard[]): readonly AdapterBoardCard[] => {
      const memory = readBoardMemory(taskMemoryFile(config.stateDir));
      const inFlight = new Set<string>();
      for (const card of cards) {
        if (card.state.phase === "executing") inFlight.add(card.state.assignment.attemptId);
      }
      const notices = reviewSteward(memory.ledger, memory.activity, inFlight);
      const projectOf = (card: AdapterBoardCard): string | null =>
        "intake" in card.state ? card.state.intake.projectId : null;
      const taskIds = new Set(cards.map((card) => card.taskId));
      const firstOfProject = new Map<string, string>();
      for (const card of cards) {
        const projectId = projectOf(card);
        if (projectId !== null && !firstOfProject.has(projectId)) {
          firstOfProject.set(projectId, card.taskId);
        }
      }
      const byTask = new Map<string, Array<(typeof notices)[number]>>();
      const seenNotices = new Set<string>();
      for (const notice of notices) {
        if (seenNotices.has(notice.noticeId)) continue;
        const owner = taskIds.has(notice.taskId)
          ? notice.taskId
          : (firstOfProject.get(notice.projectId) ?? null);
        if (owner === null) continue;
        seenNotices.add(notice.noticeId);
        const list = byTask.get(owner) ?? [];
        list.push(notice);
        byTask.set(owner, list);
      }
      return cards.map((card) => {
        const projectId = projectOf(card);
        const facts =
          projectId === null
            ? []
            : memory.ledger.graph.facts.filter((fact) => fact.projectId === projectId);
        const steward = [...(byTask.get(card.taskId) ?? [])];
        for (const notice of card.attention ?? []) {
          if (steward.some((item) => item.noticeId === notice.noticeId)) continue;
          steward.push(notice);
        }
        // Drop a previous join. An empty list has to replace the field, or a
        // resolved conflict stays on the card.
        const { steward: _previousSteward, memoryFacts: _previousFacts, ...rest } = card;
        return {
          ...rest,
          attempts: memory.activity.filter((item) => item.taskId === card.taskId),
          ...(steward.length === 0 ? {} : { steward }),
          ...(facts.length === 0 ? {} : { memoryFacts: facts }),
        };
      });
    };
    publishAttempts = () => {
      const current = cardsNow();
      const next = encodeAdapterBoardWire(withAttempts(current));
      if (next !== hub.snapshot()) hub.replace(next);
    };
    const commitCard = (card: AdapterBoardCard) => {
      const current = cardsNow();
      const next = current.some((item) => item.taskId === card.taskId)
        ? current.map((item) => (item.taskId === card.taskId ? card : item))
        : [...current, card];
      return hub.replace(encodeAdapterBoardWire(withAttempts(next)));
    };
    const persistApplied = (
      outcome: KanbanMoveResult & { readonly _tag: "Applied" },
      card: AdapterBoardCard | undefined,
      fields: {
        readonly taskId: string;
        readonly title: string | null;
        readonly threadId: string | null;
        readonly runId: string | null;
        readonly qaRun?: AdapterBoardCard["qaRun"];
        readonly attention?: AdapterBoardCard["attention"];
      },
    ) =>
      Effect.gen(function* () {
        const previous = hub.snapshot();
        const previousLedger = ledger;
        if (outcome.changed) {
          const title = card?.title ?? fields.title;
          if (title === null) return "needs-title" as const;
          const qaRun = fields.qaRun === undefined ? card?.qaRun : fields.qaRun;
          const attention = fields.attention === undefined ? card?.attention : fields.attention;
          const stored = commitCard({
            taskId: fields.taskId,
            title,
            state: outcome.state,
            threadId: fields.threadId,
            runId: fields.runId,
            revision: (card?.revision ?? 0) + 1,
            updatedAt: yield* stamped,
            ...(attention === undefined || attention.length === 0 ? {} : { attention }),
            ...(qaRun === undefined || qaRun === null ? {} : { qaRun }),
          });
          if (!stored) return "rejected" as const;
        }
        ledger = outcome.ledger;
        yield* persist(envelope()).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              hub.replace(previous);
              ledger = previousLedger;
            }),
          ),
        );
        return "stored" as const;
      });
    const observeThread = (
      state: BoardSequence,
      taskId: string,
      threadId: string,
      book: KanbanMoveLedger,
      changed: boolean,
    ) =>
      Effect.gen(function* () {
        const view = yield* runs
          .watchThread(threadId)
          .pipe(Effect.catchTags({ BoardRunError: () => Effect.succeed(null) }));
        if (view === null || !("assignment" in state)) {
          return { state, book, changed, runId: null as string | null };
        }
        const reported = withResolvedRevision(view);
        const planned = observationEvents({
          taskId,
          threadId,
          state,
          view: reported,
          allowLapse: view.status === "interrupted",
          workerId: state.assignment.workerId,
        });
        const completion = planned.find((item) => item.event.type === "submit_completion");
        if (completion?.event.type === "submit_completion") {
          const wrote = yield* rememberExplanation(
            taskMemoryFile(config.stateDir),
            state,
            completion.event.completion.claimedOutcome,
            completion.event.completion.evidence[0].ref,
          ).pipe(
            Effect.map(() => ({ _tag: "Ok" as const })),
            Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
          );
          if (wrote._tag === "No") {
            return { state, book, changed, runId: view.runId };
          }
        }
        let next: BoardSequence = state;
        let nextBook = book;
        let nextChanged = changed;
        for (const item of planned) {
          const applied: KanbanMoveResult = yield* applyBoardWorkflowEvent(
            next,
            item.event,
            item.idempotencyKey,
            taskId,
            nextBook,
          );
          if (applied._tag !== "Applied") break;
          next = applied.state;
          nextBook = applied.ledger;
          nextChanged = nextChanged || applied.changed;
        }
        return { state: next, book: nextBook, changed: nextChanged, runId: view.runId };
      });
    const followLaunched = (
      outcome: KanbanMoveResult,
      taskId: string,
      threadId: string | null,
      runId: string | null,
    ) =>
      Effect.gen(function* () {
        if (
          outcome._tag !== "Applied" ||
          outcome.state.phase !== "executing" ||
          threadId === null
        ) {
          return { outcome, runId };
        }
        const viewed = yield* observeThread(
          outcome.state,
          taskId,
          threadId,
          outcome.ledger,
          outcome.changed,
        );
        return {
          outcome: {
            _tag: "Applied" as const,
            state: viewed.state,
            ledger: viewed.book,
            changed: viewed.changed,
          },
          runId: viewed.runId ?? runId,
        };
      });
    const namedThread = (threadId: string | null | undefined): string | null =>
      threadId !== undefined && threadId !== null && threadId.length > 0 ? threadId : null;
    const reviewerThreadProblem = (
      reviewerThread: string | null,
      implementerThread: string | null,
      taskId: string,
      taskProjectId: string | null,
      reviewerProject: string | null | undefined,
    ): string | null => {
      if (reviewerThread === null) return null;
      if (implementerThread !== null && reviewerThread === implementerThread) {
        return "The reviewer's thread is the implementer's thread.";
      }
      const otherTask = cardsNow().find(
        (card) => card.taskId !== taskId && card.threadId === reviewerThread,
      );
      if (otherTask !== undefined) return "The reviewer's thread is not from this task.";
      if (
        taskProjectId !== null &&
        reviewerProject !== undefined &&
        reviewerProject !== null &&
        reviewerProject.length > 0 &&
        reviewerProject !== taskProjectId
      ) {
        return "The reviewer's thread is not from this task.";
      }
      return null;
    };
    const recordSubmittedReviewer = (
      state: BoardSequence,
      event: Extract<SequenceEvent, { type: "qa" }>,
      taskId: string,
      idempotencyKey: string,
      book: KanbanMoveLedger,
      implementerThreadId: string | null,
    ) =>
      Effect.gen(function* () {
        if (event.qa.availability !== "available") {
          return { _tag: "Ready" as const, state, book };
        }
        if (state.phase !== "awaiting_qa" && state.phase !== "qa_incomplete") {
          return { _tag: "Ready" as const, state, book };
        }
        const named = namedThread(event.threadId);
        const namedProblem = reviewerThreadProblem(named, implementerThreadId, taskId, null, null);
        if (namedProblem !== null) {
          return {
            _tag: "Rejected" as const,
            outcome: rejectedMove(namedProblem, state, book),
          };
        }
        const view = yield* runs
          .readReviewerSession({
            threadId: event.threadId ?? null,
            runId: event.runId ?? null,
          })
          .pipe(Effect.catchTags({ BoardRunError: () => Effect.succeed(null) }));
        const resolvedProblem = reviewerThreadProblem(
          view?.threadId ?? null,
          implementerThreadId,
          taskId,
          projectIdOf(state),
          view?.projectId,
        );
        if (resolvedProblem !== null) {
          return {
            _tag: "Rejected" as const,
            outcome: rejectedMove(resolvedProblem, state, book),
          };
        }
        const actual = view?.actualModel?.trim() ?? "";
        if (view === null || actual.length === 0) {
          return { _tag: "Ready" as const, state, book };
        }
        const recordedReviewer = state.run.reviewerRuntime?.actual ?? null;
        if (recordedReviewer !== null && !sameModelName(recordedReviewer, actual)) {
          return {
            _tag: "Rejected" as const,
            outcome: rejectedMove(
              "A verified reviewer is already recorded and cannot be replaced.",
              state,
              book,
            ),
          };
        }
        const requested = view.requestedModel?.trim() ?? "";
        const digest = yield* crypto
          .digest(
            "SHA-256",
            new TextEncoder().encode(`${taskId}\n${state.run.generation}\n${idempotencyKey}`),
          )
          .pipe(Effect.orDie);
        const applied = yield* applyBoardWorkflowEvent(
          state,
          {
            type: "record_runtime_models",
            taskId: state.acknowledgment.taskId,
            attemptId: state.assignment.attemptId,
            generation: state.run.generation,
            leaseId: state.run.leaseId,
            role: "reviewer",
            requested: requested.length > 0 ? { model: requested } : null,
            actual: { model: actual },
          },
          `reviewer-${Hex.encode(digest)}`,
          taskId,
          book,
        );
        if (applied._tag !== "Applied") return { _tag: "Rejected" as const, outcome: applied };
        return { _tag: "Ready" as const, state: applied.state, book: applied.ledger };
      });
    const finishedReview = (execution: AdvisoryExecution): execution is AdvisorySuccess =>
      execution.status === "completed" || execution.status === "model_mismatch";
    const settleAdvisory = (
      state: BoardSequence,
      book: KanbanMoveLedger,
      execution: AdvisoryExecution,
      work: { readonly taskId: string; readonly workerId: string },
    ) => {
      if (!finishedReview(execution)) {
        return applyAdvisoryStop({
          state,
          taskId: work.taskId,
          ledger: book,
          execution,
          workerId: work.workerId,
        });
      }
      const finished = execution;
      return Effect.gen(function* () {
        const wrote = yield* rememberExplanation(
          taskMemoryFile(config.stateDir),
          state,
          finished.summary,
          "advisory-review",
        ).pipe(
          Effect.map(() => ({ _tag: "Ok" as const })),
          Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
        );
        if (wrote._tag === "No") return rejectedMove(wrote.detail, state, book);
        return yield* applyAdvisoryExecution({
          state,
          taskId: work.taskId,
          ledger: book,
          execution: finished,
          workerId: work.workerId,
        });
      });
    };
    const settleOpenAdvisory = Effect.gen(function* () {
      for (const card of cardsNow()) {
        if (card.state.phase !== "executing") continue;
        if (declaredTaskType(card.state.assignment) !== "advisory") continue;
        yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const fresh = cardsNow().find((item) => item.taskId === card.taskId);
            if (fresh === undefined || fresh.state.phase !== "executing") return;
            if (declaredTaskType(fresh.state.assignment) !== "advisory") return;
            if (!antigravitySupports("report_status")) return;
            const watched = yield* reviews.watch(fresh.taskId);
            const decoded = yield* decodeState(fresh.state);
            if (decoded._tag === "Bad" || decoded.state.phase !== "executing") return;
            // Bind before the nested generator. A closure does not keep the phase narrowing.
            const executing = decoded.state;
            if (
              watched !== null &&
              watched.generation !== undefined &&
              watched.generation !== executing.run.generation
            ) {
              return;
            }
            if (watched === null) yield* reviews.sweep(fresh.taskId);
            const outcome =
              watched === null
                ? yield* applyBoardWorkflowEvent(
                    executing,
                    {
                      type: "lease_expired",
                      lease: {
                        taskId: fresh.taskId,
                        attemptId: executing.assignment.attemptId,
                        generation: executing.run.generation,
                        leaseId: executing.run.leaseId,
                      },
                    },
                    `agy-lease-${fresh.taskId}-${executing.run.generation}`,
                    fresh.taskId,
                    ledger,
                  )
                : watched.status === "running"
                  ? null
                  : yield* settleAdvisory(executing, ledger, watched.execution, {
                      taskId: fresh.taskId,
                      workerId: executing.assignment.workerId,
                    });
            if (outcome === null || outcome._tag !== "Applied" || !outcome.changed) return;
            yield* persistApplied(outcome, fresh, {
              taskId: fresh.taskId,
              title: fresh.title,
              threadId: fresh.threadId,
              runId: fresh.runId ?? null,
            });
          }),
        );
      }
    });
    const ROLES_FILE = "ai-os-roles.json";
    const readRoles = (): Effect.Effect<RoleDefaultsFileV1> =>
      fs.readFileString(path.join(config.stateDir, ROLES_FILE)).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((text) => {
          if (text.trim().length === 0) return Effect.succeed({ projects: {} });
          return decodeRoleDefaultsFile(readJson(text)).pipe(
            Effect.orElseSucceed(() => ({ projects: {} })),
          );
        }),
      );
    const writeRoles = (file: RoleDefaultsFileV1) =>
      Effect.gen(function* () {
        const target = path.join(config.stateDir, ROLES_FILE);
        const temporary = `${target}.${yield* crypto.randomUUIDv4()}.tmp`;
        yield* fs
          .writeFileString(temporary, encodeJson(file))
          .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
        yield* fs
          .rename(temporary, target)
          .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
      });
    const modelSlug = (model: { readonly model: string } | string): string =>
      typeof model === "string" ? model : model.model;
    const fitSession = (value: string, fallback: string): string => {
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value.length <= 128) return value;
      return fallback.length <= 128 ? fallback : fallback.slice(0, 128);
    };
    const attemptIdFor = (taskId: string): string => {
      const joined = `${taskId}-attempt-1`;
      return joined.length <= 128 ? joined : `attempt-${taskId}`.slice(0, 128);
    };
    type LaunchedRun = {
      readonly outcome: KanbanMoveResult;
      readonly threadId: string | null;
      readonly runId: string | null;
    };
    const launchBoardRun = (input: {
      readonly state: BoardSequence;
      readonly title: string;
      readonly model: string;
      readonly instanceId: string;
      readonly idempotencyKey: string;
      readonly promptSuffix: string;
    }) =>
      Effect.gen(function* () {
        const projectId = projectIdOf(input.state);
        if (projectId === null) {
          return {
            _tag: "No" as const,
            detail: "This card has no project, so the run cannot be launched.",
          };
        }
        const supplied = yield* suppliedForLaunch(
          taskMemoryFile(config.stateDir),
          input.state,
        ).pipe(
          Effect.map((value) => ({ _tag: "Ok" as const, value })),
          Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
        );
        if (supplied._tag === "No") return supplied;
        const prompt =
          input.promptSuffix.length === 0
            ? supplied.value.prompt
            : `${supplied.value.prompt}\n\n${input.promptSuffix}`;
        const launched = yield* asRun(
          runs.launch({
            idempotencyKey: input.idempotencyKey,
            projectId,
            title: input.title,
            prompt,
            model: input.model,
            instanceId: input.instanceId,
            contextPackage: supplied.value.prepared.contextPackage,
          }),
        );
        if (launched._tag === "No") return launched;
        if (launched.value.runId === null) {
          return {
            _tag: "No" as const,
            detail: "Launch did not return a run, so the card stays Ready.",
          };
        }
        const confirmed = yield* asRun(
          runs.confirmLaunch({
            projectId,
            threadId: launched.value.threadId,
            runId: launched.value.runId,
          }),
        );
        if (confirmed._tag === "No") return confirmed;
        if (confirmed.value === "settled" && launched.value.disposition === "active") {
          return {
            _tag: "No" as const,
            detail: "That run already stopped. Resume it before marking In Progress.",
          };
        }
        const recorded = yield* commitSuppliedRead(
          taskMemoryFile(config.stateDir),
          supplied.value.prepared,
          supplied.value.writeToken,
        );
        if (recorded._tag === "No") return recorded;
        return { _tag: "Ok" as const, launched: launched.value };
      });
    const launchImplementation = (input: {
      readonly queued: Extract<BoardSequence, { phase: "assigned" } | { phase: "rework" }>;
      readonly title: string;
      readonly book: KanbanMoveLedger;
    }): Effect.Effect<LaunchedRun> =>
      Effect.gen(function* () {
        if (input.queued.assignment.instanceId === "antigravity") {
          return {
            outcome: rejectedMove(
              "Antigravity does not run implementation tasks. The card stays Ready.",
              input.queued,
              input.book,
            ),
            threadId: null,
            runId: null,
          };
        }
        const opened = yield* launchBoardRun({
          state: input.queued,
          title: input.title,
          model: modelSlug(input.queued.assignment.implementerModel),
          instanceId: input.queued.assignment.instanceId ?? T3_LAUNCH_DEFAULTS.instanceId,
          idempotencyKey: executionLaunchKey(
            input.queued.assignment.taskId,
            input.queued.assignment.attemptId,
            executionGeneration(input.queued),
          ),
          promptSuffix: "",
        });
        if (opened._tag === "No") {
          return {
            outcome: rejectedMove(opened.detail, input.queued, input.book),
            threadId: null,
            runId: null,
          };
        }
        const watched = yield* runs
          .watchThread(opened.launched.threadId)
          .pipe(Effect.catchTags({ BoardRunError: () => Effect.succeed(null) }));
        const reported = watched === null ? null : withResolvedRevision(watched);
        const outcome = yield* recordConfirmedRun({
          state: input.queued,
          taskId: input.queued.assignment.taskId,
          threadId: opened.launched.threadId,
          disposition: opened.launched.disposition,
          summary: opened.launched.summary,
          ledger: input.book,
          memoryFile: taskMemoryFile(config.stateDir),
          implementerRequested: reported?.requestedModel ?? null,
          implementerActual: reported?.actualModel ?? null,
          revision: reported?.revision ?? null,
        });
        return {
          outcome,
          threadId: opened.launched.threadId,
          runId: opened.launched.runId,
        };
      });
    type QaFollow = {
      readonly outcome: KanbanMoveResult;
      readonly qaRun: AdapterBoardCard["qaRun"];
      readonly rejection: string | null;
      readonly touched: boolean;
    };
    const keepQa = (outcome: KanbanMoveResult, qaRun: AdapterBoardCard["qaRun"]): QaFollow => ({
      outcome,
      qaRun: qaRun ?? null,
      rejection: null,
      touched: false,
    });
    const verdictForReview = (
      state: Extract<BoardSequence, { phase: "awaiting_qa" }>,
      text: string | null,
    ) => {
      if (text === null || text.trim().length === 0) return Effect.succeed(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return Effect.succeed(null);
      }
      const body = isRecord(parsed) && isRecord(parsed.qa) ? parsed.qa : parsed;
      if (!isRecord(body)) return Effect.succeed(null);
      // The reviewer fills the judgment. The ids and the implementer are already known.
      const merged = {
        ...body,
        version: "v1",
        taskId: state.acknowledgment.taskId,
        attemptId: state.assignment.attemptId,
        artifactRevision: state.completion.artifactRevision,
        implementerModel: modelSlug(
          state.run.implementerRuntime?.actual ?? state.assignment.implementerModel,
        ),
        ...(body.verdict === "accept"
          ? { acceptedRevision: state.completion.artifactRevision }
          : {}),
      };
      return decodeQaVerdictV1(merged).pipe(Effect.catch(() => Effect.succeed(null)));
    };
    const qaPromptSuffix = (
      state: Extract<BoardSequence, { phase: "awaiting_qa" }>,
      sha: string,
    ): string => {
      const form = {
        version: "v1",
        taskId: state.acknowledgment.taskId,
        attemptId: state.assignment.attemptId,
        availability: "available",
        qaModel: "<qa-model>",
        implementerModel: modelSlug(
          state.run.implementerRuntime?.actual ?? state.assignment.implementerModel,
        ),
        verdict: "rework",
        artifactRevision: { type: "git", sha },
        findings: [
          {
            defect: "Describe the defect.",
            evidence: "Where you saw it.",
            expectedBehavior: "What should be true.",
          },
        ],
      };
      return `Review this exact submitted revision: ${sha}
Set qaModel to the base model that ran this review. Set verdict to rework or accept. For accept, findings may be empty.
Reply with only this JSON.
${encodeJson(form)}`;
    };
    const settleQaVerdict = (
      outcome: KanbanMoveResult & { readonly _tag: "Applied" },
      qaRun: NonNullable<AdapterBoardCard["qaRun"]>,
      view: T3ThreadView,
    ): Effect.Effect<QaFollow> =>
      Effect.gen(function* () {
        if (outcome.state.phase !== "awaiting_qa") return keepQa(outcome, qaRun);
        const waiting = outcome.state;
        const verdict = yield* verdictForReview(waiting, view.text);
        if (verdict === null || verdict.availability !== "available") {
          const incomplete = yield* decodeSequenceState({
            phase: "qa_incomplete",
            intake: waiting.intake,
            acknowledgment: waiting.acknowledgment,
            assignment: waiting.assignment,
            completion: waiting.completion,
            findings: [
              {
                defect: "The QA run did not return a verdict.",
                evidence: "The reviewer reply was not a QA verdict.",
                expectedBehavior: "Reply with only the QA verdict JSON.",
              },
            ],
            artifactRevision: waiting.completion.artifactRevision,
            attemptedVerdict: "rework",
            reworkRevision: waiting.reworkRevision,
            reworkLedger: waiting.reworkLedger,
            run: waiting.run,
            commands: waiting.commands,
            qaLabel: QA_INCOMPLETE_LABEL,
          }).pipe(
            Effect.map((state) => ({ _tag: "Ok" as const, state })),
            Effect.catch(() => Effect.succeed({ _tag: "No" as const })),
          );
          if (incomplete._tag === "No") {
            return {
              outcome: { ...outcome, changed: true },
              qaRun: { ...qaRun, settled: "rejected" as const },
              rejection: "The QA run did not return a verdict.",
              touched: true,
            };
          }
          return {
            outcome: { ...outcome, state: incomplete.state, changed: true },
            qaRun,
            rejection: null,
            touched: true,
          };
        }
        const taskId = waiting.acknowledgment.taskId;
        const reviewerActual = view.actualModel?.trim() ?? "";
        const qaEvent = {
          type: "qa" as const,
          threadId: fitSession(qaRun.threadId, "qa-thread"),
          runId: fitSession(qaRun.runId, "qa-run"),
          qa: verdict,
        };
        const implementerActual = waiting.run.implementerRuntime?.actual ?? null;
        if (reviewerActual.length === 0) {
          const applied = yield* applyBoardWorkflowEvent(
            waiting,
            qaEvent,
            `qa-auto-${taskId}-${qaRun.commitSha}`,
            taskId,
            outcome.ledger,
          );
          if (applied._tag !== "Applied") {
            return {
              outcome: { ...outcome, changed: true },
              qaRun: { ...qaRun, settled: "rejected" as const },
              rejection: applied.detail,
              touched: true,
            };
          }
          return { outcome: { ...applied, changed: true }, qaRun, rejection: null, touched: true };
        }
        const runtime = yield* applyBoardWorkflowEvent(
          waiting,
          {
            type: "record_runtime_models",
            taskId,
            attemptId: waiting.assignment.attemptId,
            generation: waiting.run.generation,
            leaseId: waiting.run.leaseId,
            role: "reviewer",
            requested:
              (view.requestedModel?.trim() ?? "").length > 0
                ? { model: view.requestedModel?.trim() ?? "" }
                : null,
            actual: { model: reviewerActual },
          },
          `runtime-qa-${taskId}-${waiting.run.generation}`,
          taskId,
          outcome.ledger,
        );
        if (implementerActual !== null && sameBaseModel(reviewerActual, implementerActual)) {
          const basis = runtime._tag === "Applied" ? runtime.state : waiting;
          const book = runtime._tag === "Applied" ? runtime.ledger : outcome.ledger;
          const rejected = yield* applyBoardWorkflowEvent(
            basis,
            qaEvent,
            `qa-auto-${taskId}-${qaRun.commitSha}`,
            taskId,
            book,
          );
          return {
            outcome: { ...outcome, changed: true },
            qaRun: { ...qaRun, settled: "rejected" as const },
            rejection:
              rejected._tag === "Rejected"
                ? rejected.detail
                : "QA must use a different base model than the implementer that ran.",
            touched: true,
          };
        }
        if (runtime._tag !== "Applied" || runtime.state.phase !== "awaiting_qa") {
          return {
            outcome: { ...outcome, changed: true },
            qaRun: { ...qaRun, settled: "rejected" as const },
            rejection:
              runtime._tag === "Rejected" ? runtime.detail : "QA did not record the reviewer.",
            touched: true,
          };
        }
        const pending = yield* recordPendingVerdict(runtime.state, verdict).pipe(
          Effect.map((state) => ({ _tag: "Ok" as const, state })),
          Effect.catchTags({
            ContractTransitionError: (error) =>
              Effect.succeed({ _tag: "No" as const, detail: error.detail }),
          }),
        );
        if (pending._tag === "No") {
          return {
            outcome: { ...outcome, changed: true },
            qaRun: { ...qaRun, settled: "rejected" as const },
            rejection: pending.detail,
            touched: true,
          };
        }
        // The verdict is on the card. Rework and delivery wait for a later step.
        return {
          outcome: {
            _tag: "Applied" as const,
            state: pending.state,
            ledger: runtime.ledger,
            changed: true,
          },
          qaRun,
          rejection: null,
          touched: true,
        };
      });
    const startAutomaticQa = (
      outcome: KanbanMoveResult,
      qaRun: AdapterBoardCard["qaRun"],
      title: string,
    ): Effect.Effect<QaFollow> =>
      Effect.gen(function* () {
        if (outcome._tag !== "Applied" || outcome.state.phase !== "awaiting_qa") {
          return keepQa(outcome, qaRun);
        }
        const waiting = outcome.state;
        if (declaredTaskType(waiting.assignment) === "advisory") return keepQa(outcome, qaRun);
        if (waiting.recordedVerdict !== undefined) return keepQa(outcome, qaRun);
        if (qaRun?.settled === "rejected") return keepQa(outcome, qaRun);
        const revision = waiting.completion.artifactRevision;
        if (revision.type !== "git") return keepQa(outcome, qaRun);
        const actual = waiting.run.implementerRuntime?.actual ?? null;
        if (actual === null) return keepQa(outcome, qaRun);
        let nextRun = qaRun ?? null;
        if (nextRun === null) {
          const roles = yield* readRoles();
          const worker = qaWorkerFor(roles.projects[waiting.intake.projectId], actual);
          if (worker === null) return keepQa(outcome, null);
          const opened = yield* launchBoardRun({
            state: waiting,
            title: `${title} QA`,
            model: modelSlug(worker.model),
            instanceId: worker.instanceId,
            idempotencyKey: `qa-${waiting.acknowledgment.taskId}-${revision.sha}`,
            promptSuffix: qaPromptSuffix(waiting, revision.sha),
          });
          if (opened._tag === "No") return keepQa(outcome, null);
          const qaRunId = opened.launched.runId;
          if (qaRunId === null) return keepQa(outcome, null);
          nextRun = {
            threadId: opened.launched.threadId,
            runId: qaRunId,
            commitSha: revision.sha,
          };
        }
        const view = yield* runs
          .watchThread(nextRun.threadId)
          .pipe(Effect.catchTags({ BoardRunError: () => Effect.succeed(null) }));
        if (view === null || view.status !== "completed") {
          const started = qaRun == null;
          return {
            outcome: { ...outcome, changed: outcome.changed || started },
            qaRun: nextRun,
            rejection: null,
            touched: started,
          };
        }
        return yield* settleQaVerdict(outcome, nextRun, view);
      });
    const move = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const body = readJson(text);
          if (!isRecord(body)) return json(400, { detail: "Expected a JSON object." });
          const taskId = stringField(body, "taskId");
          const idempotencyKey = stringField(body, "idempotencyKey");
          if (taskId === null || idempotencyKey === null || !isColumn(body.column)) {
            return json(400, { detail: "Expected taskId, column, and idempotencyKey." });
          }
          const card = cardsNow().find((item) => item.taskId === taskId);
          if (card === undefined) return json(404, { detail: "No task with that id." });
          const decoded = yield* decodeState(card.state);
          if (decoded._tag === "Bad") {
            return json(500, { detail: "The stored task state is invalid." });
          }
          const requestInput = {
            taskId,
            column: body.column,
            idempotencyKey,
            confirmed: body.confirmed === true,
            at: yield* stamped,
            ledger,
          };
          const asked = yield* requestKanbanMove(decoded.state, requestInput);
          let launchedThread = card.threadId;
          let launchedRun = card.runId ?? null;
          const openAdvisoryRun = (
            queued: Extract<BoardSequence, { phase: "assigned" } | { phase: "rework" }>,
            projectId: string,
            book: KanbanMoveLedger,
            rejectedState: BoardSequence,
          ) =>
            Effect.gen(function* () {
              if (!antigravitySupports("start")) {
                return rejectedMove("Antigravity does not implement start.", rejectedState, book);
              }
              const typed = stringField(body, "model")?.trim() ?? "";
              const requested =
                typed.length > 0 ? typed : (queued.assignment.advisoryModel?.model ?? undefined);
              const generation = executionGeneration(queued);
              const supplied = yield* suppliedForLaunch(
                taskMemoryFile(config.stateDir),
                queued,
              ).pipe(
                Effect.map((value) => ({ _tag: "Ok" as const, value })),
                Effect.catch((error) =>
                  Effect.succeed({ _tag: "No" as const, detail: error.message }),
                ),
              );
              if (supplied._tag === "No") return rejectedMove(supplied.detail, rejectedState, book);
              const opened = yield* reviews.start({
                projectId,
                taskId,
                generation,
                intake: queued.intake,
                context: supplied.value.prepared.contextPackage,
                orientation: supplied.value.lines,
                requestedModel: requested,
              });
              if (opened.status === "unavailable") {
                return rejectedMove(opened.detail, rejectedState, book);
              }
              const recorded = yield* commitSuppliedRead(
                taskMemoryFile(config.stateDir),
                supplied.value.prepared,
                supplied.value.writeToken,
              );
              if (recorded._tag === "No") return rejectedMove(recorded.detail, rejectedState, book);
              const started = yield* applyBoardWorkflowEvent(
                queued,
                { type: "start_execution" },
                `agy-start-${taskId}-${generation}`,
                taskId,
                book,
              );
              if (started._tag !== "Applied" || started.state.phase !== "executing") {
                return started;
              }
              return {
                _tag: "Running" as const,
                started,
                opened: opened as Exclude<AdvisoryOpen, { status: "unavailable" }>,
              };
            });
          const outcome =
            asked._tag === "NeedsInterrupt"
              ? yield* Effect.gen(function* () {
                  if (
                    "assignment" in decoded.state &&
                    declaredTaskType(decoded.state.assignment) === "advisory"
                  ) {
                    if (!antigravitySupports("cancel")) {
                      return {
                        _tag: "Rejected" as const,
                        detail: "Antigravity does not implement cancel.",
                        state: decoded.state,
                        ledger,
                      };
                    }
                    const stopped = yield* asRun(reviews.cancel(taskId));
                    if (stopped._tag === "No") {
                      return {
                        _tag: "Rejected" as const,
                        detail: stopped.detail,
                        state: decoded.state,
                        ledger,
                      };
                    }
                    if (decoded.state.phase !== "executing") {
                      return {
                        _tag: "Rejected" as const,
                        detail: "The run is no longer active, so the card was left as it is.",
                        state: decoded.state,
                        ledger,
                      };
                    }
                    // Cancel only asks the process to stop. The card stays blocked
                    // until recover confirms the process is gone and the worktree is cleaned.
                    const executing = decoded.state;
                    return yield* applyBoardWorkflowEvent(
                      executing,
                      {
                        type: "lease_expired",
                        lease: {
                          taskId,
                          attemptId: executing.assignment.attemptId,
                          generation: executing.run.generation,
                          leaseId: executing.run.leaseId,
                        },
                      },
                      `${idempotencyKey}-block`,
                      taskId,
                      ledger,
                    );
                  }
                  const threadId = card.threadId;
                  const runId = card.runId ?? null;
                  if (threadId === null || runId === null) {
                    return {
                      _tag: "Rejected" as const,
                      detail: "This card has no T3 run to interrupt.",
                      state: decoded.state,
                      ledger,
                    };
                  }
                  const projectId = projectIdOf(decoded.state);
                  if (projectId === null) {
                    return {
                      _tag: "Rejected" as const,
                      detail: "This card has no project, so the run cannot be interrupted.",
                      state: decoded.state,
                      ledger,
                    };
                  }
                  const interrupted = yield* asRun(
                    runs.interrupt({
                      projectId,
                      threadId,
                      runId,
                      commandId: `board-interrupt-${idempotencyKey}`,
                    }),
                  );
                  if (interrupted._tag === "No" || interrupted.value !== "requested") {
                    return {
                      _tag: "Rejected" as const,
                      detail:
                        interrupted._tag === "No"
                          ? interrupted.detail
                          : "The run did not confirm the interrupt, so the card stays here.",
                      state: decoded.state,
                      ledger,
                    };
                  }
                  return yield* commitInterruptedMove(decoded.state, requestInput);
                })
              : asked._tag === "NeedsLaunch"
                ? yield* Effect.gen(function* () {
                    const queued = decoded.state;
                    if (queued.phase !== "assigned" && queued.phase !== "rework") {
                      return rejectedMove(
                        "In Progress starts from Ready only after a worker is assigned.",
                        queued,
                        ledger,
                      );
                    }
                    const projectId = projectIdOf(queued);
                    if (projectId === null) {
                      return rejectedMove(
                        "This card has no project, so the run cannot be launched.",
                        queued,
                        ledger,
                      );
                    }
                    if (declaredTaskType(queued.assignment) === "advisory") {
                      const opened = yield* openAdvisoryRun(queued, projectId, ledger, queued);
                      if (opened._tag !== "Running") return opened;
                      const watched = !antigravitySupports("report_status")
                        ? null
                        : opened.opened.status === "settled"
                          ? { status: "settled" as const, execution: opened.opened.execution }
                          : yield* reviews.watch(taskId);
                      if (watched === null || watched.status === "running") {
                        launchedRun = opened.opened.runId;
                        return opened.started;
                      }
                      return yield* settleAdvisory(
                        opened.started.state,
                        opened.started.ledger,
                        watched.execution,
                        {
                          taskId,
                          workerId: queued.assignment.workerId,
                        },
                      );
                    }
                    const launched = yield* launchImplementation({
                      queued,
                      title: card.title,
                      book: ledger,
                    });
                    if (launched.threadId !== null) launchedThread = launched.threadId;
                    if (launched.runId !== null) launchedRun = launched.runId;
                    return launched.outcome;
                  })
                : asked._tag === "NeedsRecover"
                  ? yield* Effect.gen(function* () {
                      const waiting = decoded.state;
                      if (waiting.phase !== "recovery_pending") {
                        return rejectedMove(
                          "In Progress resumes from Blocked only after a run was interrupted.",
                          waiting,
                          ledger,
                        );
                      }
                      if (declaredTaskType(waiting.assignment) === "advisory") {
                        if (!antigravitySupports("start")) {
                          return rejectedMove(
                            "Antigravity does not implement start.",
                            waiting,
                            ledger,
                          );
                        }
                        const recovered = yield* reviews.recover(taskId);
                        if (recovered.status === "still_running") {
                          return rejectedMove(
                            "The earlier advisory review is still running. It stays blocked until that process is confirmed stopped.",
                            waiting,
                            ledger,
                          );
                        }
                        const generation = waiting.run.generation;
                        const nextAttemptId = `retry-${taskId}-${generation + 1}`.slice(0, 128);
                        const resolved = yield* applyBoardWorkflowEvent(
                          waiting,
                          {
                            type: "resolve_recovery",
                            command: {
                              command: "resolve_recovery",
                              outcome: "continue",
                              idempotencyKey: `agy-recover-${taskId}-${generation}`,
                              taskId,
                              attemptId: waiting.assignment.attemptId,
                              nextAttemptId,
                            },
                          },
                          `agy-recover-${taskId}-${generation}`,
                          taskId,
                          ledger,
                        );
                        if (resolved._tag !== "Applied" || resolved.state.phase !== "assigned") {
                          return resolved;
                        }
                        const queued = resolved.state;
                        const projectId = projectIdOf(queued);
                        if (projectId === null) {
                          return rejectedMove(
                            "This card has no project, so the review cannot be started.",
                            waiting,
                            ledger,
                          );
                        }
                        const opened = yield* openAdvisoryRun(
                          queued,
                          projectId,
                          resolved.ledger,
                          waiting,
                        );
                        if (opened._tag !== "Running") return opened;
                        launchedRun = opened.opened.runId;
                        return opened.started;
                      }
                      const threadId = card.threadId;
                      const runId = card.runId ?? null;
                      if (threadId === null || runId === null) {
                        return rejectedMove(
                          "The interrupted task has no T3 run to continue.",
                          waiting,
                          ledger,
                        );
                      }
                      const projectId = projectIdOf(waiting);
                      if (projectId === null) {
                        return rejectedMove(
                          "This card has no project, so the run cannot be resumed.",
                          waiting,
                          ledger,
                        );
                      }
                      const resolved = yield* applyBoardWorkflowEvent(
                        waiting,
                        {
                          type: "resolve_recovery",
                          command: {
                            command: "resolve_recovery",
                            outcome: "continue",
                            idempotencyKey: `resume-${taskId}`,
                            taskId,
                            attemptId: waiting.assignment.attemptId,
                          },
                        },
                        `resume-${taskId}`,
                        taskId,
                        ledger,
                      );
                      if (resolved._tag !== "Applied" || resolved.state.phase !== "assigned") {
                        return resolved;
                      }
                      const generation = resolved.state.nextGeneration;
                      const continued = yield* asRun(
                        runs.continueRun({
                          projectId,
                          threadId,
                          runId,
                          commandId: `continue-${taskId}-${generation}`,
                          messageId: `continue-msg-${taskId}-${generation}`,
                          text: "Continue the interrupted run on this thread.",
                        }),
                      );
                      if (continued._tag === "No") {
                        return rejectedMove(continued.detail, waiting, ledger);
                      }
                      launchedThread = threadId;
                      launchedRun = continued.value.runId ?? runId;
                      return yield* applyBoardWorkflowEvent(
                        resolved.state,
                        { type: "start_execution" },
                        `start-${taskId}-${generation}`,
                        taskId,
                        resolved.ledger,
                      );
                    })
                  : asked;
          const followed = yield* followLaunched(outcome, taskId, launchedThread, launchedRun);
          if (followed.outcome._tag !== "Applied") return json(409, publicMove(followed.outcome));
          const qa = yield* startAutomaticQa(followed.outcome, card.qaRun ?? null, card.title);
          if (qa.outcome._tag !== "Applied") return json(409, publicMove(qa.outcome));
          const saved = yield* persistApplied(qa.outcome, card, {
            taskId,
            title: card.title,
            threadId: launchedThread,
            runId: followed.runId,
            ...(qa.touched ? { qaRun: qa.qaRun } : {}),
          });
          if (saved !== "stored") {
            return json(500, { detail: "The workflow state could not be stored." });
          }
          if (qa.rejection !== null) return json(409, { _tag: "Rejected", detail: qa.rejection });
          return json(200, {
            ...publicMove(qa.outcome),
            revision: (card.revision ?? 0) + (qa.outcome.changed ? 1 : 0),
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const workflowEvent = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const body = readJson(text);
          if (!isRecord(body)) return json(400, { detail: "Expected a JSON object." });
          const taskId = stringField(body, "taskId");
          const idempotencyKey = stringField(body, "idempotencyKey");
          if (taskId === null || idempotencyKey === null || !("event" in body)) {
            return json(400, { detail: "Expected taskId, idempotencyKey, and event." });
          }
          const decoded = yield* decodeEvent(body.event);
          if (decoded._tag === "Bad") return json(400, { detail: "The event is not valid." });
          const card = cardsNow().find((item) => item.taskId === taskId);
          const stored =
            card === undefined
              ? { _tag: "Missing" as const }
              : yield* decodeState(card.state).pipe(
                  Effect.map((result) =>
                    result._tag === "Bad"
                      ? { _tag: "Bad" as const }
                      : { _tag: "Ok" as const, state: result.state },
                  ),
                );
          if (stored._tag === "Bad") {
            return json(500, { detail: "The stored task state is invalid." });
          }
          const replay = ledger[idempotencyKey] !== undefined;
          const threadId =
            typeof body.threadId === "string" ? body.threadId : (card?.threadId ?? null);
          const runId = typeof body.runId === "string" ? body.runId : (card?.runId ?? null);
          if (!replay && stored._tag === "Ok" && decoded.event.type === "start_execution") {
            if (threadId === null || runId === null) {
              return json(409, {
                _tag: "Rejected",
                detail: "In Progress is recorded only after the adapter launches a run.",
              });
            }
            const projectId = projectIdOf(stored.state);
            if (projectId === null) {
              return json(409, {
                _tag: "Rejected",
                detail: "This card has no project, so the run cannot be checked.",
              });
            }
            const confirmed = yield* asRun(runs.confirmLaunch({ projectId, threadId, runId }));
            if (confirmed._tag === "No") {
              return json(409, { _tag: "Rejected", detail: confirmed.detail });
            }
          }
          if (!replay && stored._tag === "Ok" && decoded.event.type === "submit_completion") {
            const wrote = yield* rememberExplanation(
              taskMemoryFile(config.stateDir),
              stored.state,
              decoded.event.completion.claimedOutcome,
              decoded.event.completion.evidence[0].ref,
            ).pipe(
              Effect.map(() => ({ _tag: "Ok" as const })),
              Effect.catch((error) =>
                Effect.succeed({ _tag: "No" as const, detail: error.message }),
              ),
            );
            if (wrote._tag === "No") {
              return json(409, { _tag: "Rejected", detail: wrote.detail });
            }
          }
          if (
            !replay &&
            stored._tag === "Ok" &&
            (decoded.event.type === "cancel" || decoded.event.type === "lease_expired")
          ) {
            if (
              "assignment" in stored.state &&
              declaredTaskType(stored.state.assignment) === "advisory"
            ) {
              if (!antigravitySupports("cancel")) {
                return json(409, {
                  _tag: "Rejected",
                  detail: "Antigravity does not implement cancel.",
                });
              }
              yield* reviews.cancel(taskId);
              if (decoded.event.type === "cancel" && stored.state.phase === "executing") {
                const executing = stored.state;
                const blocked = yield* applyBoardWorkflowEvent(
                  executing,
                  {
                    type: "lease_expired",
                    lease: {
                      taskId,
                      attemptId: executing.assignment.attemptId,
                      generation: executing.run.generation,
                      leaseId: executing.run.leaseId,
                    },
                  },
                  idempotencyKey,
                  taskId,
                  ledger,
                );
                if (blocked._tag !== "Applied") return json(409, publicMove(blocked));
                const blockedSaved = yield* persistApplied(blocked, card, {
                  taskId,
                  title: stringField(body, "title"),
                  threadId,
                  runId,
                });
                if (blockedSaved === "needs-title") {
                  return json(400, { detail: "A new task needs a title." });
                }
                if (blockedSaved !== "stored") {
                  return json(400, { detail: "The task could not be stored." });
                }
                return json(200, {
                  ...publicMove(blocked),
                  revision: (card?.revision ?? 0) + (blocked.changed ? 1 : 0),
                });
              }
            } else {
              if (threadId === null || runId === null) {
                return json(409, {
                  _tag: "Rejected",
                  detail: "This card has no T3 run to interrupt.",
                });
              }
              const projectId = projectIdOf(stored.state);
              if (projectId === null) {
                return json(409, {
                  _tag: "Rejected",
                  detail: "This card has no project, so the run cannot be interrupted.",
                });
              }
              const interrupted = yield* asRun(
                runs.interrupt({
                  projectId,
                  threadId,
                  runId,
                  commandId: `board-interrupt-${idempotencyKey}`,
                }),
              );
              if (interrupted._tag === "No") {
                return json(409, { _tag: "Rejected", detail: interrupted.detail });
              }
            }
          }
          if (
            !replay &&
            stored._tag === "Ok" &&
            decoded.event.type === "continue" &&
            "assignment" in stored.state &&
            declaredTaskType(stored.state.assignment) === "advisory" &&
            stored.state.phase === "recovery_pending"
          ) {
            if (!antigravitySupports("start")) {
              return json(409, {
                _tag: "Rejected",
                detail: "Antigravity does not implement start.",
              });
            }
            const waiting = stored.state;
            const recovered = yield* reviews.recover(taskId);
            if (recovered.status === "still_running") {
              return json(409, {
                _tag: "Rejected",
                detail:
                  "The earlier advisory review is still running. It stays blocked until that process is confirmed stopped.",
              });
            }
            const generation = waiting.run.generation;
            const nextAttemptId = `retry-${taskId}-${generation + 1}`.slice(0, 128);
            const resolved = yield* applyBoardWorkflowEvent(
              waiting,
              {
                type: "resolve_recovery",
                command: {
                  command: "resolve_recovery",
                  outcome: "continue",
                  idempotencyKey: `agy-recover-${taskId}-${generation}`,
                  taskId,
                  attemptId: waiting.assignment.attemptId,
                  nextAttemptId,
                },
              },
              `agy-recover-${taskId}-${generation}`,
              taskId,
              ledger,
            );
            if (resolved._tag !== "Applied" || resolved.state.phase !== "assigned") {
              return json(409, publicMove(resolved));
            }
            const queued = resolved.state;
            const projectId = projectIdOf(queued);
            if (projectId === null) {
              return json(409, {
                _tag: "Rejected",
                detail: "This card has no project, so the review cannot be started.",
              });
            }
            const typed = stringField(body, "model")?.trim() ?? "";
            const requested =
              typed.length > 0 ? typed : (queued.assignment.advisoryModel?.model ?? undefined);
            const supplied = yield* suppliedForLaunch(taskMemoryFile(config.stateDir), queued).pipe(
              Effect.map((value) => ({ _tag: "Ok" as const, value })),
              Effect.catch((error) =>
                Effect.succeed({ _tag: "No" as const, detail: error.message }),
              ),
            );
            if (supplied._tag === "No") {
              return json(409, { _tag: "Rejected", detail: supplied.detail });
            }
            const opened = yield* reviews.start({
              projectId,
              taskId,
              generation: executionGeneration(queued),
              intake: queued.intake,
              context: supplied.value.prepared.contextPackage,
              orientation: supplied.value.lines,
              requestedModel: requested,
            });
            if (opened.status === "unavailable") {
              return json(409, { _tag: "Rejected", detail: opened.detail });
            }
            const recorded = yield* commitSuppliedRead(
              taskMemoryFile(config.stateDir),
              supplied.value.prepared,
              supplied.value.writeToken,
            );
            if (recorded._tag === "No") {
              return json(409, { _tag: "Rejected", detail: recorded.detail });
            }
            const started = yield* applyBoardWorkflowEvent(
              queued,
              { type: "start_execution" },
              idempotencyKey,
              taskId,
              resolved.ledger,
            );
            if (started._tag !== "Applied" || started.state.phase !== "executing") {
              return json(409, publicMove(started));
            }
            const resumed = yield* persistApplied(started, card, {
              taskId,
              title: stringField(body, "title"),
              threadId,
              runId: opened.runId,
            });
            if (resumed === "needs-title")
              return json(400, { detail: "A new task needs a title." });
            if (resumed !== "stored") return json(400, { detail: "The task could not be stored." });
            return json(200, {
              ...publicMove(started),
              revision: (card?.revision ?? 0) + (started.changed ? 1 : 0),
            });
          }
          const prepared =
            stored._tag === "Ok" && !replay && decoded.event.type === "qa"
              ? yield* recordSubmittedReviewer(
                  stored.state,
                  decoded.event,
                  taskId,
                  idempotencyKey,
                  ledger,
                  card?.threadId ?? null,
                )
              : null;
          if (prepared !== null && prepared._tag === "Rejected") {
            return json(409, publicMove(prepared.outcome));
          }
          const outcome =
            stored._tag === "Missing"
              ? yield* openBoardTask(decoded.event, idempotencyKey, taskId, ledger)
              : yield* applyBoardWorkflowEvent(
                  prepared !== null && prepared._tag === "Ready" ? prepared.state : stored.state,
                  decoded.event,
                  idempotencyKey,
                  taskId,
                  prepared !== null && prepared._tag === "Ready" ? prepared.book : ledger,
                );
          if (outcome._tag !== "Applied") return json(409, publicMove(outcome));
          const qa = yield* startAutomaticQa(
            outcome,
            card?.qaRun ?? null,
            card?.title ?? stringField(body, "title") ?? taskId,
          );
          if (qa.outcome._tag !== "Applied") return json(409, publicMove(qa.outcome));
          const saved = yield* persistApplied(qa.outcome, card, {
            taskId,
            title: stringField(body, "title"),
            threadId,
            runId,
            ...(qa.touched ? { qaRun: qa.qaRun } : {}),
          });
          if (saved === "needs-title") return json(400, { detail: "A new task needs a title." });
          if (saved !== "stored") return json(400, { detail: "The task could not be stored." });
          if (qa.rejection !== null) return json(409, { _tag: "Rejected", detail: qa.rejection });
          return json(200, {
            ...publicMove(qa.outcome),
            revision: (card?.revision ?? 0) + (qa.outcome.changed ? 1 : 0),
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const followExecuting = Effect.gen(function* () {
      const open = cardsNow().filter(
        (card) => card.threadId !== null && card.state.phase === "executing",
      );
      for (const card of open) {
        yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const fresh = cardsNow().find((item) => item.taskId === card.taskId);
            if (
              fresh === undefined ||
              fresh.threadId === null ||
              fresh.state.phase !== "executing"
            ) {
              return;
            }
            const decoded = yield* decodeState(fresh.state);
            if (decoded._tag === "Bad") return;
            const followed = yield* followLaunched(
              { _tag: "Applied", state: decoded.state, changed: false, ledger },
              fresh.taskId,
              fresh.threadId,
              fresh.runId ?? null,
            );
            if (followed.outcome._tag !== "Applied") return;
            const qa = yield* startAutomaticQa(followed.outcome, fresh.qaRun ?? null, fresh.title);
            if (qa.outcome._tag !== "Applied") return;
            if (!followed.outcome.changed && !qa.touched) return;
            yield* persistApplied(qa.outcome, fresh, {
              taskId: fresh.taskId,
              title: fresh.title,
              threadId: fresh.threadId,
              runId: followed.runId,
              ...(qa.touched ? { qaRun: qa.qaRun } : {}),
            });
          }),
        );
      }
    });
    const followQa = Effect.gen(function* () {
      const open = cardsNow().filter(
        (card) =>
          card.state.phase === "awaiting_qa" &&
          card.state.recordedVerdict === undefined &&
          card.qaRun?.settled !== "rejected",
      );
      for (const card of open) {
        yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const fresh = cardsNow().find((item) => item.taskId === card.taskId);
            if (fresh === undefined || fresh.state.phase !== "awaiting_qa") return;
            if (fresh.state.recordedVerdict !== undefined || fresh.qaRun?.settled === "rejected") {
              return;
            }
            const qa = yield* startAutomaticQa(
              { _tag: "Applied", state: fresh.state, changed: false, ledger },
              fresh.qaRun ?? null,
              fresh.title,
            );
            if (!qa.touched || qa.outcome._tag !== "Applied") return;
            yield* persistApplied(qa.outcome, fresh, {
              taskId: fresh.taskId,
              title: fresh.title,
              threadId: fresh.threadId,
              runId: fresh.runId ?? null,
              qaRun: qa.qaRun,
            });
          }),
        );
      }
    });
    const followLoop = followExecuting.pipe(
      Effect.andThen(followQa),
      Effect.andThen(settleOpenAdvisory),
      Effect.catch(() => Effect.void),
      Effect.andThen(Effect.sleep(BOARD_FOLLOW_INTERVAL)),
      Effect.forever,
    );
    const models = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      const catalog = yield* reviews.listModels();
      return json(200, {
        source: catalog.source,
        models: catalog.models.map((model) => ({ slug: model.slug, label: model.label })),
        detail: catalog.detail,
      });
    }).pipe(Effect.catchTags(authResponse));
    const supplyMemory = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const body = readJson(text);
          if (!isRecord(body)) return json(400, { detail: "Expected a JSON object." });
          const supplied = yield* withTaskMemory(taskMemoryFile(config.stateDir), (database) =>
            supplyLaunchReadSync(database, body, ADAPTER_MEMORY_WRITE_PATH),
          ).pipe(
            Effect.map((value) => ({ _tag: "Ok" as const, value })),
            Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
          );
          if (supplied._tag === "No") return json(400, { detail: supplied.detail });
          return json(200, {
            lines: [...supplied.value.lines],
            writeToken: supplied.value.writeToken,
            digest: supplied.value.digest,
            contextPackage: supplied.value.contextPackage,
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const commitMemory = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const body = readJson(text);
          if (!isRecord(body)) return json(400, { detail: "Expected a JSON object." });
          const committed = yield* withTaskMemory(taskMemoryFile(config.stateDir), (database) =>
            commitLaunchReadSync(database, body),
          ).pipe(
            Effect.map(() => ({ _tag: "Ok" as const })),
            Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
          );
          if (committed._tag === "No") return json(409, { detail: committed.detail });
          publishAttempts();
          return json(200, { stored: true });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const resolveConflict = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const body = readJson(text);
          if (!isRecord(body)) return json(400, { detail: "Expected a JSON object." });
          const conflictId = stringField(body, "conflictId");
          const action = stringField(body, "action");
          if (
            conflictId === null ||
            (action !== "keep" && action !== "accept" && action !== "correct")
          ) {
            return json(400, { detail: "Expected conflictId and keep, accept, or correct." });
          }
          const statement = stringField(body, "body") ?? undefined;
          const createdAt = yield* stamped;
          const resolved = yield* withTaskMemory(taskMemoryFile(config.stateDir), (database) =>
            resolveMemoryConflictSync(database, {
              action,
              conflictId,
              body: statement,
              createdAt,
            }),
          ).pipe(
            Effect.map((receipt) => ({ _tag: "Ok" as const, receipt })),
            Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
          );
          if (resolved._tag === "No")
            return json(409, { _tag: "Rejected", detail: resolved.detail });
          if (resolved.receipt.outcome !== "accepted" && resolved.receipt.outcome !== "duplicate") {
            return json(409, { _tag: "Rejected", detail: resolved.receipt.detail });
          }
          publishAttempts();
          return json(200, {
            _tag: "Applied",
            outcome: resolved.receipt.outcome,
            detail: resolved.receipt.detail,
            factIds: resolved.receipt.factIds,
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const writeMemory = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const body = readJson(text);
          if (!isRecord(body)) return json(400, { detail: "Expected a JSON object." });
          const attemptId = stringField(body, "attemptId");
          const writeToken = stringField(body, "writeToken");
          if (attemptId === null || writeToken === null || !("write" in body)) {
            return json(400, { detail: "Expected attemptId, writeToken, and write." });
          }
          const running = cardsNow().find(
            (card) =>
              card.state.phase === "executing" && card.state.assignment.attemptId === attemptId,
          );
          if (running === undefined || running.state.phase !== "executing") {
            return json(409, { _tag: "Rejected", detail: "This attempt is not running." });
          }
          const projectId = projectIdOf(running.state);
          if (projectId === null) {
            return json(409, { _tag: "Rejected", detail: "This run has no project." });
          }
          const wrote = yield* withTaskMemory(taskMemoryFile(config.stateDir), (database) =>
            submitAttemptMemorySync(database, attemptId, projectId, body.write, "jim", writeToken),
          ).pipe(
            Effect.map((receipt) => ({ _tag: "Ok" as const, receipt })),
            Effect.catch((error) => Effect.succeed({ _tag: "No" as const, detail: error.message })),
          );
          if (wrote._tag === "No") return json(409, { _tag: "Rejected", detail: wrote.detail });
          if (wrote.receipt.outcome === "rejected") {
            return json(409, { _tag: "Rejected", detail: wrote.receipt.detail });
          }
          publishAttempts();
          return json(200, {
            _tag: "Applied",
            outcome: wrote.receipt.outcome,
            detail: wrote.receipt.detail,
            submissionId: wrote.receipt.submissionId,
            factIds: wrote.receipt.factIds,
            conflictIds: wrote.receipt.conflictIds,
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const saveRoles = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const decoded = yield* decodeRolePost(readJson(text)).pipe(
        Effect.map((value) => ({ _tag: "Ok" as const, value })),
        Effect.catch(() => Effect.succeed({ _tag: "Bad" as const })),
      );
      if (decoded._tag === "Bad")
        return json(400, { detail: "Expected a project and its role workers." });
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readRoles();
          const previous = current.projects[decoded.value.projectId];
          const next = {
            ...previous,
            ...(decoded.value.implementer === undefined
              ? {}
              : { implementer: decoded.value.implementer }),
            ...(decoded.value.qa === undefined ? {} : { qa: decoded.value.qa }),
          };
          yield* writeRoles({
            projects: { ...current.projects, [decoded.value.projectId]: next },
          });
          return json(200, { projectId: decoded.value.projectId });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    const requestTask = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const decoded = yield* decodeRequestPost(readJson(text)).pipe(
        Effect.map((value) => ({ _tag: "Ok" as const, value })),
        Effect.catch(() => Effect.succeed({ _tag: "Bad" as const })),
      );
      if (decoded._tag === "Bad") {
        return json(400, {
          detail: "Expected taskId, title, idempotencyKey, repoCommit, and intake.",
        });
      }
      const body = decoded.value;
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const existing = cardsNow().find((card) => card.taskId === body.taskId);
          let book = ledger;
          let card = existing;
          let state: BoardSequence;
          if (existing === undefined) {
            const opened = yield* openBoardTask(
              { type: "intake", intake: body.intake },
              body.idempotencyKey,
              body.taskId,
              book,
            );
            if (opened._tag !== "Applied") return json(409, publicMove(opened));
            const ready = yield* requestKanbanMove(opened.state, {
              taskId: body.taskId,
              column: "Ready",
              idempotencyKey: `${body.idempotencyKey}-ready`,
              confirmed: true,
              at: yield* stamped,
              ledger: opened.ledger,
            });
            if (ready._tag !== "Applied") return json(409, publicMove(ready));
            state = ready.state;
            book = ready.ledger;
          } else {
            const stored = yield* decodeState(existing.state);
            if (stored._tag === "Bad")
              return json(500, { detail: "The stored task state is invalid." });
            state = stored.state;
          }
          let attention = card?.attention;
          if (state.phase === "acknowledged") {
            const roles = yield* readRoles();
            const worker = eligibleImplementer(roles.projects[state.intake.projectId]);
            if (worker === null) {
              attention = [needsWorkerNotice(state.intake.projectId, body.taskId)];
              const saved = yield* persistApplied(
                { _tag: "Applied", state, ledger: book, changed: true },
                card,
                {
                  taskId: body.taskId,
                  title: card?.title ?? body.title,
                  threadId: card?.threadId ?? null,
                  runId: card?.runId ?? null,
                  attention,
                },
              );
              if (saved !== "stored") return json(400, { detail: "The task could not be stored." });
              return json(200, { _tag: "NeedsYou", detail: attention[0]?.summary ?? "" });
            }
            const createdAt = yield* stamped;
            const assignment = yield* decodeAssignmentV1({
              version: "v1",
              taskId: body.taskId,
              attemptId: attemptIdFor(body.taskId),
              assignmentId: attemptIdFor(body.taskId).replace("-attempt-1", "-assignment-1"),
              workerId: worker.workerId,
              implementerModel: worker.model,
              instanceId: worker.instanceId,
              role: "implementer",
              taskType: "implementation",
              scope: state.intake.request,
              contextPackage: {
                requirements: state.intake.request,
                memoryVersions: [],
                repoCommit: body.repoCommit,
                authorizationScope: state.intake.authorization.scope,
                createdAt,
              },
            }).pipe(
              Effect.map((value) => ({ _tag: "Ok" as const, value })),
              Effect.catch(() => Effect.succeed({ _tag: "Bad" as const })),
            );
            if (assignment._tag === "Bad") {
              return json(400, { detail: "The configured implementer is not a valid assignment." });
            }
            const assigned = yield* applyBoardWorkflowEvent(
              state,
              { type: "assign", assignment: assignment.value },
              `${body.idempotencyKey}-assign`,
              body.taskId,
              book,
            );
            if (assigned._tag !== "Applied" || assigned.state.phase !== "assigned") {
              return json(409, publicMove(assigned));
            }
            state = assigned.state;
            book = assigned.ledger;
            attention = [];
          }
          let threadId = card?.threadId ?? null;
          let runId = card?.runId ?? null;
          let outcome: KanbanMoveResult = {
            _tag: "Applied",
            state,
            ledger: book,
            changed: existing === undefined || state.phase === "assigned",
          };
          if (state.phase === "assigned" || state.phase === "rework") {
            const launched = yield* launchImplementation({
              queued: state,
              title: card?.title ?? body.title,
              book,
            });
            if (launched.threadId !== null) threadId = launched.threadId;
            if (launched.runId !== null) runId = launched.runId;
            if (launched.outcome._tag !== "Applied") {
              yield* persistApplied(
                {
                  _tag: "Applied",
                  state: launched.outcome.state,
                  ledger: launched.outcome.ledger,
                  changed: true,
                },
                card,
                {
                  taskId: body.taskId,
                  title: card?.title ?? body.title,
                  threadId,
                  runId,
                  attention,
                },
              );
              return json(409, publicMove(launched.outcome));
            }
            const followed = yield* followLaunched(launched.outcome, body.taskId, threadId, runId);
            outcome = followed.outcome;
            runId = followed.runId ?? runId;
          } else {
            outcome = { ...outcome, changed: existing === undefined };
          }
          if (outcome._tag !== "Applied") return json(409, publicMove(outcome));
          const qa = yield* startAutomaticQa(
            outcome,
            card?.qaRun ?? null,
            card?.title ?? body.title,
          );
          if (qa.outcome._tag !== "Applied") return json(409, publicMove(qa.outcome));
          if (existing !== undefined && !qa.outcome.changed && !qa.touched) {
            return json(200, {
              _tag: "Applied",
              changed: false,
              revision: existing.revision ?? 0,
            });
          }
          const saved = yield* persistApplied(qa.outcome, card, {
            taskId: body.taskId,
            title: card?.title ?? body.title,
            threadId,
            runId,
            attention,
            ...(qa.touched ? { qaRun: qa.qaRun } : {}),
          });
          if (saved === "needs-title") return json(400, { detail: "A new task needs a title." });
          if (saved !== "stored") return json(400, { detail: "The task could not be stored." });
          if (qa.rejection !== null) return json(409, { _tag: "Rejected", detail: qa.rejection });
          return json(200, {
            ...publicMove(qa.outcome),
            revision: (card?.revision ?? 0) + (qa.outcome.changed ? 1 : 0),
          });
        }),
      );
    }).pipe(
      Effect.catchTags(authResponse),
      Effect.catch((cause) =>
        failEnvironmentInternal("internal_error", cause).pipe(
          Effect.catchTags({
            EnvironmentInternalError: (error) => HttpServerRespondable.toResponse(error),
          }),
        ),
      ),
    );
    return Layer.mergeAll(
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, snapshot),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, replace),
      HttpRouter.add("GET", ADAPTER_BOARD_EVENTS_PATH, events),
      HttpRouter.add("POST", ADAPTER_BOARD_MOVE_PATH, move),
      HttpRouter.add("POST", ADAPTER_BOARD_EVENT_PATH, workflowEvent),
      HttpRouter.add("POST", ADAPTER_MEMORY_RESOLVE_PATH, resolveConflict),
      HttpRouter.add("POST", ADAPTER_MEMORY_SUPPLY_PATH, supplyMemory),
      HttpRouter.add("POST", ADAPTER_MEMORY_COMMIT_PATH, commitMemory),
      HttpRouter.add("POST", ADAPTER_MEMORY_WRITE_PATH, writeMemory),
      HttpRouter.add("POST", ADAPTER_ROLES_PATH, saveRoles),
      HttpRouter.add("POST", ADAPTER_REQUEST_PATH, requestTask),
      HttpRouter.add("GET", ADAPTER_ANTIGRAVITY_MODELS_PATH, models),
      Layer.effectDiscard(
        Effect.gen(function* () {
          yield* settleOpenAdvisory;
          if (!runs.followRuns) return;
          yield* Effect.forkScoped(followLoop);
        }),
      ),
    );
  }),
);
