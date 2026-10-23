import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ContextPackageSnapshotV1, type SequenceEvent } from "@t3tools/ai-os-contracts";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  CommandId,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2GetThreadProjectionInput,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
  ProjectId,
  ProviderInstanceId,
  RpcScopeAuthorization,
  WS_METHODS,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";

import {
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_PATH,
  decodeAdapterBoard,
  type AdapterBoardCard,
} from "./board.ts";
import { encodeAdapterBoardWire } from "./boardHub.ts";
import { GrokT3Error } from "./errors.ts";

/** Default origin of a local T3 server. Tests pass the fake server's origin instead. */
export const T3_LOCAL_ORIGIN = "http://127.0.0.1:3773";

/** Fields every launch sends besides the task title, prompt, and context. */
export const T3_LAUNCH_DEFAULTS = {
  instanceId: "codex",
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
} as const;

/**
 * The three orchestration methods this adapter calls. Schemas are the real
 * contract schemas, and the tags are the real websocket method names.
 */
export const T3OrchestrationRpc = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
    payload: OrchestrationV2RpcSchemas.launchThread.input,
    success: OrchestrationV2RpcSchemas.launchThread.output,
    error: OrchestrationV2ThreadLaunchError,
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    payload: OrchestrationV2Command,
    success: OrchestrationV2RpcSchemas.dispatchCommand.output,
    error: OrchestrationV2DispatchCommandError,
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
    payload: OrchestrationV2GetThreadProjectionInput,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: OrchestrationV2GetThreadProjectionError,
  }),
).middleware(RpcScopeAuthorization);

const decodeAccessToken = Schema.decodeUnknownEffect(Schema.fromJsonString(AuthAccessTokenResult));
const decodeProjectList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      projects: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          workspaceRoot: Schema.String,
          deletedAt: Schema.NullOr(Schema.String),
          defaultModelSelection: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
);
const WebSocketTicketJson = Schema.toCodecJson(AuthWebSocketTicketResult);
const decodeWebSocketTicket = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WebSocketTicketJson),
);

export interface T3LaunchRequest {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly title: string;
  readonly prompt: string;
  readonly contextPackage: ContextPackageSnapshotV1;
  readonly model: string;
  readonly instanceId?: string;
}

export interface T3LaunchResult {
  readonly threadId: string;
  readonly runId: string | null;
  readonly resumed: boolean;
}

export interface T3ThreadView {
  readonly threadId: string;
  readonly runId: string | null;
  readonly status: "running" | "completed" | "interrupted" | "failed" | "idle";
  readonly text: string | null;
  readonly revision: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface T3ContinueRequest {
  readonly threadId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
}

export interface T3ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModel: T3ModelSelection | null;
}

export interface T3ModelSelection {
  readonly instanceId: string;
  readonly model: string;
}

export interface T3ModelOffer {
  readonly slug: string;
  readonly aliases: readonly string[];
  readonly isDefault: boolean;
}

export interface T3ProviderModels {
  readonly instanceId: string;
  readonly models: readonly T3ModelOffer[];
}

export interface T3ModelCatalog {
  readonly providers: readonly T3ProviderModels[];
  readonly serverDefault: T3ModelSelection | null;
}

export interface T3BoardEvent {
  readonly taskId: string;
  readonly title: string;
  readonly idempotencyKey: string;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly event: SequenceEvent;
}

export interface T3LocalClient {
  readonly launch: (input: T3LaunchRequest) => Effect.Effect<T3LaunchResult, GrokT3Error>;
  readonly read: (threadId: string) => Effect.Effect<T3ThreadView, GrokT3Error>;
  readonly interrupt: (threadId: string, runId: string) => Effect.Effect<void, GrokT3Error>;
  readonly continueRun: (input: T3ContinueRequest) => Effect.Effect<void, GrokT3Error>;
  readonly publishBoard: (
    cards: readonly AdapterBoardCard[],
  ) => Effect.Effect<readonly AdapterBoardCard[], GrokT3Error>;
  readonly publishEvent: (
    input: T3BoardEvent,
  ) => Effect.Effect<{ readonly revision: number }, GrokT3Error>;
  readonly readBoard: () => Effect.Effect<readonly AdapterBoardCard[], GrokT3Error>;
  readonly listProjectIds: () => Effect.Effect<readonly T3ProjectSummary[], GrokT3Error>;
  readonly listProviderModels: () => Effect.Effect<T3ModelCatalog, GrokT3Error>;
  /**
   * POST a JSON body to one of the server's `/api/drive/*` routes and return
   * the JSON answer. The Drive token stays on the server. Optional so test
   * fakes need not implement it.
   */
  readonly driveCall?: (
    route: "search" | "list" | "snapshot" | "snapshot/status" | "verify",
    body: Record<string, unknown>,
  ) => Effect.Effect<unknown, GrokT3Error>;
}

const unavailable = (detail: string) => new GrokT3Error({ reason: "t3_unavailable", detail });

const rejected = (detail: string) => new GrokT3Error({ reason: "t3_rejected", detail });

const detailOf = (error: { readonly message?: string }) =>
  error.message !== undefined && error.message.length > 0
    ? error.message
    : "T3 rejected the request.";

/** Stable command id for one launch payload. The same key reuses the same thread. */
export const launchCommandId = (idempotencyKey: string): string => {
  let hash = 5381;
  for (let index = 0; index < idempotencyKey.length; index += 1) {
    hash = (hash * 33 + idempotencyKey.charCodeAt(index)) | 0;
  }
  return `launch-${(hash >>> 0).toString(16)}`;
};

const socketUrl = (origin: string, wsTicket: string): string => {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  url.searchParams.set("wsTicket", wsTicket);
  return url.toString();
};

const requestedScopes = `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`;

const usingHttp = (origin: string) => {
  const mapTransport = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.mapError((error) =>
        isGrokT3Error(error) ? error : unavailable(`T3 did not answer ${origin}.`),
      ),
    );
  return mapTransport;
};

const messageContext = (context: ContextPackageSnapshotV1) => ({
  version: 1 as const,
  records: [
    {
      version: 1 as const,
      contextId: "context-package",
      label: "Context package",
      kind: "context-package",
      payload: context,
    },
  ],
});

export const threadViewFromProjection = (
  threadId: string,
  projection: OrchestrationV2ThreadProjection,
): T3ThreadView => {
  const run = projection.runs.at(-1);
  const status =
    run === undefined
      ? "idle"
      : run.status === "completed"
        ? "completed"
        : run.status === "failed"
          ? "failed"
          : run.status === "interrupted" ||
              run.status === "cancelled" ||
              run.status === "rolled_back"
            ? "interrupted"
            : "running";
  const assistant = projection.messages.findLast(
    (message) => message.role === "assistant" && message.text.length > 0,
  );
  const revision = projection.checkpoints.at(-1)?.ref ?? null;
  const usage = projection.providerTurns.at(-1)?.tokenUsage;
  return {
    threadId,
    runId: run?.id ?? null,
    status,
    text: assistant?.text ?? null,
    revision,
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
};

type T3RpcClient = RpcClient.RpcClient.From<
  RpcGroup.Rpcs<typeof T3OrchestrationRpc>,
  RpcClientError
>;

const isGrokT3Error = (error: unknown): error is GrokT3Error =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "GrokT3Error";

const statusError = (status: number, action: string) =>
  status === 401
    ? new GrokT3Error({
        reason: "unauthenticated",
        detail: `T3 rejected the credential while trying to ${action}.`,
      })
    : new GrokT3Error({
        reason: "t3_rejected",
        detail: `T3 refused to ${action} (${status}).`,
      });

const withRpc = <A>(
  origin: string,
  wsTicket: string,
  use: (client: T3RpcClient) => Effect.Effect<A, GrokT3Error>,
): Effect.Effect<A, GrokT3Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      });
      const client = yield* RpcClient.make(T3OrchestrationRpc).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      return yield* use(client);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeSocket.layerWebSocket(socketUrl(origin, wsTicket), { openTimeout: "5 seconds" }),
        RpcSerialization.layerJson,
      ),
    ),
    Effect.mapError((error) =>
      isGrokT3Error(error) ? error : unavailable(`T3 did not answer ${origin}.`),
    ),
  );

export interface T3ClientOptions {
  readonly origin: string;
  readonly pairingToken?: string;
}

const modelSelectionOf = (value: unknown): T3ModelSelection | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const instanceId =
    typeof record.instanceId === "string"
      ? record.instanceId
      : typeof record.provider === "string"
        ? record.provider
        : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (instanceId.length === 0 || model.length === 0) return null;
  return { instanceId, model };
};

/** Pull provider models and the server default out of a `server.getConfig` payload. */
export const readProviderCatalog = (value: unknown): T3ModelCatalog | null => {
  if (typeof value !== "object" || value === null || !("providers" in value)) return null;
  const providersValue = (value as { readonly providers?: unknown }).providers;
  if (!Array.isArray(providersValue)) return null;
  const providers: T3ProviderModels[] = [];
  for (const entry of providersValue) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.enabled === false) continue;
    if (typeof record.instanceId !== "string" || record.instanceId.length === 0) continue;
    if (!Array.isArray(record.models)) continue;
    const models: T3ModelOffer[] = [];
    for (const model of record.models) {
      if (typeof model !== "object" || model === null) continue;
      const item = model as Record<string, unknown>;
      if (item.isLegacy === true) continue;
      if (typeof item.slug !== "string" || item.slug.trim().length === 0) continue;
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.flatMap((alias) =>
            typeof alias === "string" && alias.length > 0 ? [alias] : [],
          )
        : [];
      models.push({
        slug: item.slug.trim(),
        aliases,
        isDefault: item.isDefault === true,
      });
    }
    providers.push({ instanceId: record.instanceId, models });
  }
  const settings = (value as { readonly settings?: unknown }).settings;
  const serverDefault =
    typeof settings === "object" && settings !== null
      ? modelSelectionOf(
          (settings as { readonly defaultModelSelection?: unknown }).defaultModelSelection,
        )
      : null;
  return { providers, serverDefault };
};

const RpcCallFailure = Schema.Struct({});

export const T3ConfigRpc = RpcGroup.make(
  Rpc.make(WS_METHODS.serverGetConfig, {
    payload: Schema.Struct({}),
    success: Schema.Unknown,
    error: RpcCallFailure,
  }),
).middleware(RpcScopeAuthorization);

/**
 * Websocket client for a local T3 server.
 *
 * A pairing token, when one is set, is exchanged for a bearer. Loopback calls
 * with no token send no Authorization header and rely on the server's loopback
 * owner session. Each socket mints its own `wsTicket`, because the upgrade
 * authenticates that ticket and RPC then checks scopes. Launch is
 * `orchestration.launchThread`. Cancel is `run.interrupt`.
 * Continue is `message.dispatch` with `manualContinuationOfRunId`. Reads use
 * `orchestration.getThreadProjection`. Nothing here spawns Codex or calls an
 * update endpoint.
 */
export const wsT3LocalClient = (options: T3ClientOptions): T3LocalClient => {
  const { origin, pairingToken } = options;
  const http = usingHttp(origin);
  let cachedBearer: string | undefined;
  const exchange = Effect.gen(function* () {
    const tokenValue = pairingToken?.trim() ?? "";
    if (tokenValue.length === 0) {
      return yield* new GrokT3Error({
        reason: "unauthenticated",
        detail: "Set T3_PAIRING_TOKEN.",
      });
    }
    const body = new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: tokenValue,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      scope: requestedScopes,
    }).toString();
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/oauth/token`).pipe(
        HttpClientRequest.bodyText(body, "application/x-www-form-urlencoded"),
      ),
    );
    if (response.status !== 200) {
      return yield* statusError(response.status, "exchange the pairing token");
    }
    const token = yield* decodeAccessToken(yield* response.text).pipe(
      Effect.mapError(() => unavailable("T3 returned an unreadable access token.")),
    );
    cachedBearer = token.access_token;
    return token.access_token;
  });
  const accessToken = Effect.gen(function* () {
    if (cachedBearer !== undefined) return cachedBearer;
    return yield* exchange;
  });
  const responseFor = (build: () => HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const tokenValue = pairingToken?.trim() ?? "";
      const request =
        tokenValue.length === 0
          ? build()
          : HttpClientRequest.setHeader(build(), "authorization", `Bearer ${yield* accessToken}`);
      return yield* HttpClient.execute(request);
    });
  const issueTicket = http(
    Effect.gen(function* () {
      const response = yield* responseFor(() =>
        HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`),
      );
      if (response.status !== 200) {
        return yield* statusError(response.status, "issue a websocket ticket");
      }
      const ticket = yield* decodeWebSocketTicket(yield* response.text).pipe(
        Effect.mapError(() => unavailable("T3 returned an unreadable websocket ticket.")),
      );
      return ticket.ticket;
    }),
  );
  const connected = <A>(use: (client: T3RpcClient) => Effect.Effect<A, GrokT3Error>) =>
    Effect.gen(function* () {
      const wsTicket = yield* issueTicket;
      return yield* withRpc(origin, wsTicket, use);
    });
  const launch = (input: T3LaunchRequest) =>
    connected((client) =>
      Effect.gen(function* () {
        const result = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make(launchCommandId(input.idempotencyKey)),
          projectId: ProjectId.make(input.projectId),
          title: input.title,
          modelSelection: {
            instanceId: ProviderInstanceId.make(input.instanceId ?? T3_LAUNCH_DEFAULTS.instanceId),
            model: input.model,
          },
          runtimeMode: T3_LAUNCH_DEFAULTS.runtimeMode,
          interactionMode: T3_LAUNCH_DEFAULTS.interactionMode,
          workspaceStrategy: T3_LAUNCH_DEFAULTS.workspaceStrategy,
          initialMessage: {
            text: input.prompt,
            attachments: [],
            context: messageContext(input.contextPackage),
          },
        }).pipe(Effect.mapError((error) => rejected(detailOf(error))));
        return {
          threadId: result.threadId,
          runId: result.projection.runs.at(-1)?.id ?? null,
          resumed: result.resumed,
        };
      }),
    );
  const read = (threadId: string) =>
    connected((client) =>
      Effect.gen(function* () {
        const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make(threadId),
        }).pipe(Effect.mapError((error) => rejected(detailOf(error))));
        return threadViewFromProjection(threadId, projection);
      }),
    );
  const interrupt = (threadId: string, runId: string) =>
    connected((client) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "run.interrupt",
        commandId: CommandId.make(`interrupt-${threadId}-${runId}`),
        threadId: ThreadId.make(threadId),
        runId: RunId.make(runId),
      }).pipe(
        Effect.mapError((error) => rejected(detailOf(error))),
        Effect.asVoid,
      ),
    );
  const continueRun = (input: T3ContinueRequest) =>
    connected((client) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
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
      }).pipe(
        Effect.mapError((error) => rejected(detailOf(error))),
        Effect.asVoid,
      ),
    );
  const phaseOf = (state: unknown): string | null =>
    typeof state === "object" &&
    state !== null &&
    "phase" in state &&
    typeof state.phase === "string"
      ? state.phase
      : null;
  const readCards = (text: string) => {
    const cards = decodeAdapterBoard(text);
    return cards === null
      ? Effect.fail(
          new GrokT3Error({ reason: "t3_rejected", detail: "T3 returned an unreadable board." }),
        )
      : Effect.succeed(
          cards.map((card) => ({
            ...card,
            runId: card.runId ?? null,
            revision: card.revision ?? 0,
          })),
        );
  };
  const postCards = (cards: readonly AdapterBoardCard[]) =>
    responseFor(() =>
      HttpClientRequest.post(`${origin}${ADAPTER_BOARD_PATH}`).pipe(
        HttpClientRequest.bodyText(encodeAdapterBoardWire(cards), "application/json"),
      ),
    );
  const publishBoard = (cards: readonly AdapterBoardCard[]) =>
    http(
      Effect.gen(function* () {
        const finish = <E>(response: {
          readonly status: number;
          readonly text: Effect.Effect<string, E>;
        }) =>
          Effect.gen(function* () {
            if (response.status >= 400)
              return yield* statusError(response.status, "publish the board");
            return yield* readCards(yield* response.text);
          });
        const first = yield* postCards(cards);
        if (first.status !== 409) return yield* finish(first);
        const current = yield* responseFor(() =>
          HttpClientRequest.get(`${origin}${ADAPTER_BOARD_PATH}`),
        );
        if (current.status >= 400) return yield* statusError(current.status, "read the board");
        const server = yield* readCards(yield* current.text);
        const refreshed = cards.map((card) => {
          const stored = server.find((item) => item.taskId === card.taskId);
          if (stored === undefined || phaseOf(stored.state) !== phaseOf(card.state)) return card;
          return { ...card, revision: stored.revision };
        });
        return yield* finish(yield* postCards(refreshed));
      }),
    );
  const publishEvent = (input: T3BoardEvent) =>
    http(
      Effect.gen(function* () {
        const response = yield* responseFor(() =>
          HttpClientRequest.post(`${origin}${ADAPTER_BOARD_EVENT_PATH}`).pipe(
            HttpClientRequest.bodyText(
              Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(input),
              "application/json",
            ),
          ),
        );
        if (response.status >= 400) {
          return yield* statusError(response.status, "publish the workflow event");
        }
        const text = yield* response.text;
        const parsed = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ revision: Schema.Number })),
        )(text).pipe(
          Effect.mapError(
            () =>
              new GrokT3Error({
                reason: "t3_rejected",
                detail: "T3 returned an unreadable workflow result.",
              }),
          ),
        );
        return { revision: parsed.revision };
      }),
    );
  const readBoard = () =>
    http(
      Effect.gen(function* () {
        const response = yield* responseFor(() =>
          HttpClientRequest.get(`${origin}${ADAPTER_BOARD_PATH}`),
        );
        if (response.status >= 400) return yield* statusError(response.status, "read the board");
        return yield* readCards(yield* response.text);
      }),
    );
  const listProjectIds = () =>
    http(
      Effect.gen(function* () {
        const response = yield* responseFor(() => HttpClientRequest.get(`${origin}/api/projects`));
        if (response.status !== 200) {
          return yield* statusError(response.status, "list projects");
        }
        const body = yield* decodeProjectList(yield* response.text).pipe(
          Effect.mapError(() => unavailable("T3 returned an unreadable project list.")),
        );
        return body.projects.flatMap((project) =>
          project.deletedAt === null
            ? [
                {
                  id: project.id,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  defaultModel: modelSelectionOf(project.defaultModelSelection),
                },
              ]
            : [],
        );
      }),
    );
  const listProviderModels = () =>
    Effect.gen(function* () {
      const wsTicket = yield* issueTicket;
      const config = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          });
          const client = yield* RpcClient.make(T3ConfigRpc).pipe(
            Effect.provideService(RpcClient.Protocol, protocol),
          );
          return yield* client[WS_METHODS.serverGetConfig]({}).pipe(
            Effect.mapError(() => unavailable("T3 did not answer with its model list.")),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeSocket.layerWebSocket(socketUrl(origin, wsTicket), { openTimeout: "5 seconds" }),
            RpcSerialization.layerJson,
          ),
        ),
        Effect.mapError((error) =>
          isGrokT3Error(error) ? error : unavailable("T3 did not answer with its model list."),
        ),
      );
      const catalog = readProviderCatalog(config);
      if (catalog === null) {
        return yield* unavailable("T3 returned an unreadable model list.");
      }
      return catalog;
    });
  const driveCall = (
    route: "search" | "list" | "snapshot" | "snapshot/status" | "verify",
    body: Record<string, unknown>,
  ) =>
    http(
      Effect.gen(function* () {
        const response = yield* responseFor(() =>
          HttpClientRequest.post(`${origin}/api/drive/${route}`).pipe(
            HttpClientRequest.bodyText(
              Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(body),
              "application/json",
            ),
          ),
        );
        const text = yield* response.text;
        const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
          Effect.orElseSucceed((): unknown => null),
        );
        if (response.status >= 400) {
          const serverError =
            typeof parsed === "object" &&
            parsed !== null &&
            "error" in parsed &&
            typeof parsed.error === "string"
              ? parsed.error
              : null;
          // A restarting server behind a proxy answers 503/504, or a 502 that is
          // not the Drive routes' own JSON error: the server is unavailable, not refusing.
          const unavailableNow =
            response.status === 503 ||
            response.status === 504 ||
            (response.status === 502 && serverError === null);
          return yield* new GrokT3Error({
            reason:
              response.status === 401
                ? "unauthenticated"
                : unavailableNow
                  ? "t3_unavailable"
                  : "t3_rejected",
            detail: serverError ?? `Drive ${route} failed (${response.status}).`,
          });
        }
        return parsed;
      }),
    );
  return {
    launch,
    read,
    interrupt,
    continueRun,
    publishBoard,
    publishEvent,
    readBoard,
    listProjectIds,
    listProviderModels,
    driveCall,
  };
};
