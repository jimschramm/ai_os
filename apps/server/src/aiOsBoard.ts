import {
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_MOVE_PATH,
  ADAPTER_BOARD_PATH,
  decodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import { encodeAdapterBoardWire, makeAdapterBoardHub } from "@t3tools/ai-os-adapter/board-hub";
import {
  applyBoardWorkflowEvent,
  commitInterruptedMove,
  decodeSequenceEvent,
  decodeSequenceState,
  openBoardTask,
  requestKanbanMove,
  SequenceState,
  type KanbanColumn,
  type KanbanMoveLedger,
  type KanbanMoveResult,
} from "@t3tools/ai-os-contracts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
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

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "./auth/http.ts";
import * as ServerConfig from "./config.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";

const BOARD_FILE = "ai-os-board.json";
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
    }) => Effect.Effect<void, BoardRunError>;
  }
>()("t3/aiOsBoard/BoardRuns") {}

const runError = (detail: string) => new BoardRunError({ detail });

const INTERRUPT_UNCONFIRMED = "The run did not confirm the interrupt.";

export const liveRuns = Layer.effect(
  BoardRuns,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
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
        Effect.mapError(() =>
          runError("That run is not active, so the board will not mark it in progress."),
        ),
        Effect.flatMap((shell) => {
          const detail = "That run is not active, so the board will not mark it in progress.";
          if (shell === null || shell.activeRunId !== RunId.make(input.runId)) {
            return Effect.fail(runError(detail));
          }
          if (shell.projectId !== ProjectId.make(input.projectId)) {
            return Effect.fail(runError("The run belongs to a different project."));
          }
          return Effect.void;
        }),
      );
    return { interrupt, confirmLaunch };
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
    const filePath = path.join(config.stateDir, BOARD_FILE);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);
    const hub = makeAdapterBoardHub();
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
      return yield* hub.events;
    }).pipe(Effect.catchTags(authResponse));
    const cardsNow = () => decodeAdapterBoard(hub.snapshot()) ?? [];
    const commitCard = (card: AdapterBoardCard) => {
      const current = cardsNow();
      const next = current.some((item) => item.taskId === card.taskId)
        ? current.map((item) => (item.taskId === card.taskId ? card : item))
        : [...current, card];
      return hub.replace(encodeAdapterBoardWire(next));
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
          const outcome =
            asked._tag === "NeedsInterrupt"
              ? yield* Effect.gen(function* () {
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
              : asked;
          if (outcome._tag !== "Applied") return json(409, publicMove(outcome));
          const saved = yield* persistApplied(outcome, card, {
            taskId,
            title: card.title,
            threadId: card.threadId,
            runId: card.runId ?? null,
          });
          if (saved !== "stored") {
            return json(500, { detail: "The workflow state could not be stored." });
          }
          return json(200, {
            ...publicMove(outcome),
            revision: (card.revision ?? 0) + (outcome.changed ? 1 : 0),
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
          if (
            !replay &&
            stored._tag === "Ok" &&
            (decoded.event.type === "cancel" || decoded.event.type === "lease_expired")
          ) {
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
          const outcome =
            stored._tag === "Missing"
              ? yield* openBoardTask(decoded.event, idempotencyKey, taskId, ledger)
              : yield* applyBoardWorkflowEvent(
                  stored.state,
                  decoded.event,
                  idempotencyKey,
                  taskId,
                  ledger,
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
    return Layer.mergeAll(
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, snapshot),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, replace),
      HttpRouter.add("GET", ADAPTER_BOARD_EVENTS_PATH, events),
      HttpRouter.add("POST", ADAPTER_BOARD_MOVE_PATH, move),
      HttpRouter.add("POST", ADAPTER_BOARD_EVENT_PATH, workflowEvent),
    );
  }),
);
