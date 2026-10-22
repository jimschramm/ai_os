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
  decodeSequenceEvent,
  decodeSequenceState,
  openBoardTask,
  requestKanbanMove,
  type KanbanColumn,
  type KanbanMoveLedger,
  type KanbanMoveResult,
} from "@t3tools/ai-os-contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

const BOARD_FILE = "ai-os-board.json";
const COLUMNS = ["Backlog", "Ready", "Running", "Review", "Blocked", "Done"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isColumn = (value: unknown): value is KanbanColumn =>
  typeof value === "string" && (COLUMNS as readonly string[]).includes(value);

const json = (
  status: number,
  body:
    | { readonly _tag: "Applied"; readonly changed: boolean }
    | { readonly _tag: "Rejected" | "NeedsConfirmation"; readonly detail: string }
    | { readonly detail: string },
) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
  });

const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const stringField = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null;

const stamped = Effect.map(DateTime.now, DateTime.formatIso);

const encodeOne = (card: AdapterBoardCard): string | null => {
  try {
    return encodeAdapterBoardWire([card]);
  } catch {
    return null;
  }
};

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
    const filePath = path.join(config.stateDir, BOARD_FILE);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);
    const hub = makeAdapterBoardHub();
    const existing = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (existing.length > 0) hub.replace(existing);
    let ledger: KanbanMoveLedger = {};
    // One permit so two publishes cannot read the same snapshot and rename over each other.
    const writes = yield* Semaphore.make(1);
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
          if (!hub.upsert(text)) {
            return HttpServerResponse.text("Invalid board.", { status: 400 });
          }
          yield* persist(hub.snapshot()).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                hub.replace(previous);
              }),
            ),
          );
          return HttpServerResponse.empty({ status: 204 });
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
    const storeCard = (card: AdapterBoardCard) =>
      Effect.gen(function* () {
        const encoded = encodeOne(card);
        if (encoded === null) return "rejected" as const;
        const previous = hub.snapshot();
        if (!hub.upsert(encoded)) return "rejected" as const;
        yield* persist(hub.snapshot()).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              hub.replace(previous);
            }),
          ),
        );
        return "stored" as const;
      });
    const remember = (outcome: KanbanMoveResult & { readonly _tag: "Applied" }) => {
      ledger = outcome.ledger;
    };
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
          const outcome = yield* requestKanbanMove(decoded.state, {
            taskId,
            column: body.column,
            idempotencyKey,
            confirmed: body.confirmed === true,
            at: yield* stamped,
            ledger,
          });
          if (outcome._tag !== "Applied") return json(409, publicMove(outcome));
          if (outcome.changed) {
            const saved = yield* storeCard({
              ...card,
              state: outcome.state,
              updatedAt: yield* stamped,
            });
            if (saved === "rejected") {
              return json(500, { detail: "The workflow state could not be stored." });
            }
          }
          remember(outcome);
          return json(200, publicMove(outcome));
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
          const outcome =
            card === undefined
              ? yield* openBoardTask(decoded.event, idempotencyKey, taskId, ledger)
              : yield* decodeState(card.state).pipe(
                  Effect.flatMap((stored) =>
                    stored._tag === "Bad"
                      ? Effect.succeed({
                          _tag: "Rejected" as const,
                          detail: "The stored task state is invalid.",
                          state: card.state,
                          ledger,
                        })
                      : applyBoardWorkflowEvent(
                          stored.state,
                          decoded.event,
                          idempotencyKey,
                          taskId,
                          ledger,
                        ),
                  ),
                );
          if (outcome._tag !== "Applied") return json(409, publicMove(outcome));
          if (outcome.changed) {
            const title = card?.title ?? stringField(body, "title");
            if (title === null) return json(400, { detail: "A new task needs a title." });
            const threadValue = body.threadId;
            const threadId =
              card?.threadId ??
              (typeof threadValue === "string" ? threadValue : threadValue === null ? null : null);
            if (
              card === undefined &&
              threadValue !== undefined &&
              threadValue !== null &&
              typeof threadValue !== "string"
            ) {
              return json(400, { detail: "threadId must be a string or null." });
            }
            const saved = yield* storeCard({
              taskId,
              title,
              state: outcome.state,
              threadId,
              updatedAt: yield* stamped,
            });
            if (saved === "rejected") {
              return json(400, { detail: "The task could not be stored." });
            }
          }
          remember(outcome);
          return json(200, publicMove(outcome));
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
