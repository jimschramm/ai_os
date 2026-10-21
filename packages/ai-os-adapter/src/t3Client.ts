import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ContextPackageSnapshotV1 } from "@t3tools/ai-os-contracts";
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

import { ADAPTER_BOARD_PATH, type AdapterBoardCard } from "./board.ts";
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
}

export interface T3LaunchResult {
  readonly threadId: string;
  readonly runId: string | null;
  readonly resumed: boolean;
}

export interface T3ThreadView {
  readonly threadId: string;
  readonly runId: string | null;
  readonly status: "running" | "completed" | "interrupted" | "idle";
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
}

export interface T3LocalClient {
  readonly launch: (input: T3LaunchRequest) => Effect.Effect<T3LaunchResult, GrokT3Error>;
  readonly read: (threadId: string) => Effect.Effect<T3ThreadView, GrokT3Error>;
  readonly interrupt: (threadId: string, runId: string) => Effect.Effect<void, GrokT3Error>;
  readonly continueRun: (input: T3ContinueRequest) => Effect.Effect<void, GrokT3Error>;
  readonly publishBoard: (cards: readonly AdapterBoardCard[]) => Effect.Effect<void, GrokT3Error>;
  readonly listProjectIds: () => Effect.Effect<readonly T3ProjectSummary[], GrokT3Error>;
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

const viewFromProjection = (
  threadId: string,
  projection: OrchestrationV2ThreadProjection,
): T3ThreadView => {
  const run = projection.runs.at(-1);
  const status =
    run === undefined
      ? "idle"
      : run.status === "completed"
        ? "completed"
        : run.status === "interrupted" ||
            run.status === "failed" ||
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
  readonly pairingToken: string;
}

/**
 * Websocket client for a local T3 server.
 *
 * A pairing token is exchanged for a bearer, and each socket mints its own
 * `wsTicket`, because the upgrade authenticates that ticket and RPC then checks
 * scopes. Launch is `orchestration.launchThread`. Cancel is `run.interrupt`.
 * Continue is `message.dispatch` with `manualContinuationOfRunId`. Reads use
 * `orchestration.getThreadProjection`. Nothing here spawns Codex or calls an
 * update endpoint.
 */
export const wsT3LocalClient = (options: T3ClientOptions): T3LocalClient => {
  const { origin, pairingToken } = options;
  const http = usingHttp(origin);
  let cachedBearer: string | undefined;
  const accessToken = http(
    Effect.gen(function* () {
      if (cachedBearer !== undefined) return cachedBearer;
      const body = new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: pairingToken,
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
    }),
  );
  const issueTicket = http(
    Effect.gen(function* () {
      const bearer = yield* accessToken;
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${bearer}`),
        ),
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
            instanceId: ProviderInstanceId.make(T3_LAUNCH_DEFAULTS.instanceId),
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
        return viewFromProjection(threadId, projection);
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
  const publishBoard = (cards: readonly AdapterBoardCard[]) =>
    http(
      Effect.gen(function* () {
        const bearer = yield* accessToken;
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${origin}${ADAPTER_BOARD_PATH}`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${bearer}`),
            HttpClientRequest.bodyText(encodeAdapterBoardWire(cards), "application/json"),
          ),
        );
        if (response.status >= 400) {
          return yield* statusError(response.status, "publish the board");
        }
      }),
    );
  const listProjectIds = () =>
    http(
      Effect.gen(function* () {
        const bearer = yield* accessToken;
        const response = yield* HttpClient.execute(
          HttpClientRequest.get(`${origin}/api/projects`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${bearer}`),
          ),
        );
        if (response.status !== 200) {
          return yield* statusError(response.status, "list projects");
        }
        const body = yield* decodeProjectList(yield* response.text).pipe(
          Effect.mapError(() => unavailable("T3 returned an unreadable project list.")),
        );
        return body.projects.flatMap((project) =>
          project.deletedAt === null
            ? [{ id: project.id, title: project.title, workspaceRoot: project.workspaceRoot }]
            : [],
        );
      }),
    );
  return { launch, read, interrupt, continueRun, publishBoard, listProjectIds };
};
