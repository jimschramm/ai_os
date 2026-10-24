// @effect-diagnostics nodeBuiltinImport:off - The production memory file is under the home directory, and tests keep theirs in the temp state dir.
import * as NodeOS from "node:os";

import {
  ADAPTER_ANTIGRAVITY_MODELS_PATH,
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_MOVE_PATH,
  ADAPTER_BOARD_PATH,
  ADAPTER_MEMORY_RESOLVE_PATH,
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
  commitInterruptedMove,
  declaredTaskType,
  decodeSequenceEvent,
  decodeSequenceState,
  executionGeneration,
  executionLaunchKey,
  ContractTransitionError,
  openBoardTask,
  orientationText,
  initialMemoryLedger,
  promptCarriesMemory,
  requestKanbanMove,
  reviewSteward,
  runtimeForAssignment,
  sameModelName,
  SequenceState,
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
  commitTaskReadSync,
  prepareTaskMemorySync,
  readAttemptActivitySync,
  recordTaskWriteSync,
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
    const prepared = yield* withTaskMemory(file, (database) =>
      prepareTaskMemorySync(database, request),
    );
    const lines = orientationText(prepared.package);
    const prompt = renderSuppliedPrompt(state.intake, prepared.contextPackage, lines);
    if (!promptCarriesMemory(prepared.package, prompt)) {
      return yield* new ContractTransitionError({
        contract: "memory",
        reason: "invalid_payload",
        from: "idle",
        event: "submit",
        detail: "The launch prompt does not include the memory package.",
      });
    }
    return { prepared, prompt, lines };
  });

/** Store the read after the adapter has accepted the prompt that carries this package. */
const commitSuppliedRead = (file: string, prepared: PreparedTaskMemory) =>
  withTaskMemory(file, (database) => commitTaskReadSync(database, prepared)).pipe(
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
                artifactRevision: { type: "named", kind: "page", id: "t3-result" },
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
      return cards.map((card) => {
        const projectId = "intake" in card.state ? card.state.intake.projectId : null;
        const facts =
          projectId === null
            ? []
            : memory.ledger.graph.facts.filter((fact) => fact.projectId === projectId);
        const steward = notices.filter(
          (notice) => notice.taskId === card.taskId || notice.projectId === projectId,
        );
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
      },
    ) =>
      Effect.gen(function* () {
        const previous = hub.snapshot();
        const previousLedger = ledger;
        if (outcome.changed) {
          const title = card?.title ?? fields.title;
          if (title === null) return "needs-title" as const;
          const stored = commitCard({
            taskId: fields.taskId,
            title,
            state: outcome.state,
            threadId: fields.threadId,
            runId: fields.runId,
            revision: (card?.revision ?? 0) + 1,
            updatedAt: yield* stamped,
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
        const planned = observationEvents({
          taskId,
          threadId,
          state,
          view,
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
                    if (queued.assignment.instanceId === "antigravity") {
                      return rejectedMove(
                        "Antigravity does not run implementation tasks. The card stays Ready.",
                        queued,
                        ledger,
                      );
                    }
                    const supplied = yield* suppliedForLaunch(
                      taskMemoryFile(config.stateDir),
                      queued,
                    ).pipe(
                      Effect.map((value) => ({ _tag: "Ok" as const, value })),
                      Effect.catch((error) =>
                        Effect.succeed({ _tag: "No" as const, detail: error.message }),
                      ),
                    );
                    if (supplied._tag === "No")
                      return rejectedMove(supplied.detail, queued, ledger);
                    const launched = yield* asRun(
                      runs.launch({
                        idempotencyKey: executionLaunchKey(
                          taskId,
                          queued.assignment.attemptId,
                          executionGeneration(queued),
                        ),
                        projectId,
                        title: card.title,
                        prompt: supplied.value.prompt,
                        model: queued.assignment.implementerModel.model,
                        instanceId: queued.assignment.instanceId ?? T3_LAUNCH_DEFAULTS.instanceId,
                        contextPackage: supplied.value.prepared.contextPackage,
                      }),
                    );
                    if (launched._tag === "No") {
                      return rejectedMove(launched.detail, queued, ledger);
                    }
                    const runId = launched.value.runId;
                    if (runId === null) {
                      return rejectedMove(
                        "Launch did not return a run, so the card stays Ready.",
                        queued,
                        ledger,
                      );
                    }
                    const confirmed = yield* asRun(
                      runs.confirmLaunch({
                        projectId,
                        threadId: launched.value.threadId,
                        runId,
                      }),
                    );
                    if (confirmed._tag === "No") {
                      return rejectedMove(confirmed.detail, queued, ledger);
                    }
                    if (confirmed.value === "settled" && launched.value.disposition === "active") {
                      return rejectedMove(
                        "That run already stopped. Resume it before marking In Progress.",
                        queued,
                        ledger,
                      );
                    }
                    const recorded = yield* commitSuppliedRead(
                      taskMemoryFile(config.stateDir),
                      supplied.value.prepared,
                    );
                    if (recorded._tag === "No")
                      return rejectedMove(recorded.detail, queued, ledger);
                    launchedThread = launched.value.threadId;
                    launchedRun = runId;
                    const watched = yield* runs
                      .watchThread(launched.value.threadId)
                      .pipe(Effect.catchTags({ BoardRunError: () => Effect.succeed(null) }));
                    return yield* recordConfirmedRun({
                      state: queued,
                      taskId,
                      threadId: launched.value.threadId,
                      disposition: launched.value.disposition,
                      summary: launched.value.summary,
                      ledger,
                      memoryFile: taskMemoryFile(config.stateDir),
                      implementerRequested: watched?.requestedModel ?? null,
                      implementerActual: watched?.actualModel ?? null,
                    });
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
          const saved = yield* persistApplied(followed.outcome, card, {
            taskId,
            title: card.title,
            threadId: launchedThread,
            runId: followed.runId,
          });
          if (saved !== "stored") {
            return json(500, { detail: "The workflow state could not be stored." });
          }
          return json(200, {
            ...publicMove(followed.outcome),
            revision: (card.revision ?? 0) + (followed.outcome.changed ? 1 : 0),
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
          const saved = yield* persistApplied(outcome, card, {
            taskId,
            title: stringField(body, "title"),
            threadId,
            runId,
          });
          if (saved === "needs-title") return json(400, { detail: "A new task needs a title." });
          if (saved !== "stored") return json(400, { detail: "The task could not be stored." });
          return json(200, {
            ...publicMove(outcome),
            revision: (card?.revision ?? 0) + (outcome.changed ? 1 : 0),
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
            if (followed.outcome._tag !== "Applied" || !followed.outcome.changed) return;
            yield* persistApplied(followed.outcome, fresh, {
              taskId: fresh.taskId,
              title: fresh.title,
              threadId: fresh.threadId,
              runId: followed.runId,
            });
          }),
        );
      }
    });
    const followLoop = followExecuting.pipe(
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
    return Layer.mergeAll(
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, snapshot),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, replace),
      HttpRouter.add("GET", ADAPTER_BOARD_EVENTS_PATH, events),
      HttpRouter.add("POST", ADAPTER_BOARD_MOVE_PATH, move),
      HttpRouter.add("POST", ADAPTER_BOARD_EVENT_PATH, workflowEvent),
      HttpRouter.add("POST", ADAPTER_MEMORY_RESOLVE_PATH, resolveConflict),
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
