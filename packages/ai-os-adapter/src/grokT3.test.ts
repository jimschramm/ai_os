import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  assignmentExample,
  decodeAssignmentV1,
  decodeCompletionSubmissionV1,
  decodeIntake,
  decodeSequenceState,
  intakeV2Example,
  leaseIdFor,
  type KanbanMoveLedger,
} from "@t3tools/ai-os-contracts";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentAuthorizationError,
  MessageId,
  NodeId,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RpcScopeAuthorization,
  RunId,
  ThreadId,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as UrlParams from "effect/http/UrlParams";
import { RpcSerialization, RpcServer } from "effect/rpc";

import {
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_PATH,
} from "./board.ts";
import { acceptBoardEvent, makeAdapterBoardHub } from "./boardHub.ts";
import {
  clearAdapterBoard,
  createGrokT3Adapter,
  GrokT3Error,
  decodeAdapterBoard,
  memorySessionStore,
  readAdapterBoard,
  requireCapability,
  wsT3LocalClient,
  type WorkerAdapter,
} from "./index.ts";
import { T3OrchestrationRpc } from "./t3Client.ts";

const CLOCK = "2026-10-21T18:00:00.000Z";
const PAIR_OPERATE = "pair-operate";
const PAIR_READ = "pair-read";
const SHA = "ab".repeat(20);
const NOW = DateTime.makeUnsafe(CLOCK);
const INSTANCE = ProviderInstanceId.make("codex");

interface StoredThread {
  title: string;
  prompt: string;
  requirements: string;
  hasContext: boolean;
  model: string;
  instanceId: string;
  workspace: string;
  status: "running" | "completed" | "interrupted";
  text: string | null;
  revision: string | null;
  inputTokens?: number;
  outputTokens?: number;
  runId: string;
}

interface FakeT3 {
  readonly origin: string;
  readonly launchCount: () => number;
  readonly interruptCount: () => number;
  readonly continueCount: () => number;
  readonly threadCount: () => number;
  readonly prompt: (threadId: string) => string;
  readonly requirements: (threadId: string) => string;
  readonly hasContext: (threadId: string) => boolean;
  readonly model: (threadId: string) => string;
  readonly instanceId: (threadId: string) => string;
  readonly workspace: (threadId: string) => string;
  readonly runId: (threadId: string) => string;
  readonly continuedRunId: (threadId: string) => string | undefined;
  readonly interruptedRunId: (threadId: string) => string | undefined;
  readonly setThread: (
    threadId: string,
    patch: Partial<
      Pick<StoredThread, "status" | "text" | "revision" | "inputTokens" | "outputTokens">
    >,
  ) => void;
}

const decodeProjection = Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection);
const encodeAccessToken = Schema.encodeSync(Schema.fromJsonString(AuthAccessTokenResult));
const encodeWebSocketTicket = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(AuthWebSocketTicketResult)),
);
const decodeAccessToken = Schema.decodeUnknownEffect(Schema.fromJsonString(AuthAccessTokenResult));

const authorizationFor = (scopes: ReadonlyArray<string>) =>
  Layer.succeed(RpcScopeAuthorization, (effect, { rpc }) => {
    const required =
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getThreadProjection
        ? AuthOrchestrationReadScope
        : AuthOrchestrationOperateScope;
    return scopes.includes(required)
      ? effect
      : Effect.fail(
          new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${required}.`,
            ...authScopeRequiredResponse(required),
          }),
        );
  });

const formField = (params: UrlParams.UrlParams, key: string) => {
  const value = UrlParams.getFirst(params, key);
  return Option.isSome(value) ? value.value : undefined;
};

const projectionFor = (threadId: string, thread: StoredThread) => {
  const id = ThreadId.make(threadId);
  const runId = RunId.make(thread.runId);
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId: ProjectId.make(intakeV2Example.projectId),
      title: thread.title,
      providerInstanceId: INSTANCE,
      modelSelection: { instanceId: INSTANCE, model: thread.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId: id,
        ordinal: 1,
        providerInstanceId: INSTANCE,
        modelSelection: { instanceId: INSTANCE, model: thread.model },
        providerThreadId: null,
        userMessageId: MessageId.make("message-user"),
        rootNodeId: null,
        activeAttemptId: null,
        status: thread.status,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: thread.status === "completed" ? NOW : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns:
      thread.inputTokens === undefined || thread.outputTokens === undefined
        ? []
        : [
            {
              id: ProviderTurnId.make("turn-1"),
              providerThreadId: ProviderThreadId.make("provider-thread-1"),
              nodeId: NodeId.make("node-1"),
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "completed",
              startedAt: NOW,
              completedAt: NOW,
              tokenUsage: {
                usedTokens: thread.inputTokens + thread.outputTokens,
                inputTokens: thread.inputTokens,
                outputTokens: thread.outputTokens,
                updatedAt: CLOCK,
              },
            },
          ],
    runtimeRequests: [],
    messages:
      thread.text === null
        ? []
        : [
            {
              createdBy: "user",
              creationSource: "web",
              id: MessageId.make("message-assistant"),
              threadId: id,
              runId,
              nodeId: null,
              role: "assistant",
              text: thread.text,
              attachments: [],
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints:
      thread.revision === null
        ? []
        : [
            {
              id: CheckpointId.make("checkpoint-1"),
              threadId: id,
              scopeId: CheckpointScopeId.make("scope-1"),
              runId,
              nodeId: NodeId.make("node-1"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: 1,
              ref: CheckpointRef.make(thread.revision),
              status: "ready",
              files: [],
              capturedAt: NOW,
            },
          ],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  };
};

const makeFake = () => {
  const byCommand = new Map<string, string>();
  const threads = new Map<string, StoredThread>();
  const continues = new Map<string, string>();
  const interrupts = new Map<string, string>();
  let launches = 0;
  const handlers = T3OrchestrationRpc.of({
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
      Effect.gen(function* () {
        const existing = byCommand.get(input.commandId);
        if (existing !== undefined) {
          const thread = threads.get(existing);
          if (thread === undefined) {
            return yield* Effect.die(`Missing ${existing}`);
          }
          return {
            threadId: ThreadId.make(existing),
            projection: yield* decodeProjection(projectionFor(existing, thread)).pipe(Effect.orDie),
            resumed: true,
          };
        }
        launches += 1;
        const threadId = `t3-thread-${launches}`;
        const runId = `run-${launches}`;
        const context = input.initialMessage?.context;
        threads.set(threadId, {
          title: input.title,
          prompt: input.initialMessage?.text ?? "",
          requirements:
            context?.records.find((record) => record.kind === "context-package") === undefined
              ? ""
              : String(
                  (
                    context.records.find((record) => record.kind === "context-package") as {
                      payload?: { requirements?: string };
                    }
                  ).payload?.requirements ?? "",
                ),
          hasContext: context?.records.some((record) => record.kind === "context-package") === true,
          model: input.modelSelection.model,
          instanceId: input.modelSelection.instanceId,
          workspace: input.workspaceStrategy.type,
          status: "running",
          text: null,
          revision: null,
          runId,
        });
        byCommand.set(input.commandId, threadId);
        const thread = threads.get(threadId);
        if (thread === undefined) return yield* Effect.die(`Missing ${threadId}`);
        return {
          threadId: ThreadId.make(threadId),
          projection: yield* decodeProjection(projectionFor(threadId, thread)).pipe(Effect.orDie),
          resumed: false,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      Effect.sync(() => {
        if (command.type === "run.interrupt") {
          interrupts.set(command.threadId, command.runId);
          const thread = threads.get(command.threadId);
          if (thread !== undefined) thread.status = "interrupted";
        }
        if (
          command.type === "message.dispatch" &&
          command.manualContinuationOfRunId !== undefined
        ) {
          continues.set(command.threadId, command.manualContinuationOfRunId);
          const thread = threads.get(command.threadId);
          if (thread !== undefined) {
            thread.status = "running";
            thread.runId = `run-continued-${command.manualContinuationOfRunId}`;
          }
        }
        return { sequence: launches };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.gen(function* () {
        const thread = threads.get(input.threadId);
        if (thread === undefined) {
          return yield* Effect.die(`Missing ${input.threadId}`);
        }
        return yield* decodeProjection(projectionFor(input.threadId, thread)).pipe(Effect.orDie);
      }),
  });
  const grants = new Map<string, readonly string[]>([
    [PAIR_OPERATE, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]],
    [PAIR_READ, [AuthOrchestrationReadScope]],
  ]);
  const bearers = new Map<string, readonly string[]>();
  const tickets = new Map<string, readonly string[]>();
  let issued = 0;
  const hub = makeAdapterBoardHub();
  let ledger: KanbanMoveLedger = {};
  const handlersLayer = T3OrchestrationRpc.toLayer(handlers);
  const expiresAt = DateTime.toUtc(NOW);
  const bearerScopes = (request: HttpServerRequest.HttpServerRequest) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
    return bearers.get(header.slice("Bearer ".length).trim());
  };
  const tokenRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* request.urlParamsBody.pipe(
      Effect.orElseSucceed(() => UrlParams.make([])),
    );
    const grant = grants.get(formField(params, "subject_token") ?? "");
    if (
      formField(params, "grant_type") !== AuthTokenExchangeGrantType ||
      formField(params, "subject_token_type") !== AuthEnvironmentBootstrapTokenType ||
      formField(params, "requested_token_type") !== AuthAccessTokenType ||
      grant === undefined
    ) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const requested = formField(params, "scope");
    const asked =
      requested === undefined ? grant : requested.split(/\s+/).filter((scope) => scope.length > 0);
    const granted = asked.filter((scope) => grant.includes(scope));
    if (granted.length === 0) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    issued += 1;
    const accessToken = `access-${issued}`;
    bearers.set(accessToken, granted);
    return HttpServerResponse.text(
      encodeAccessToken({
        access_token: accessToken,
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: 3600,
        scope: granted.join(" "),
      }),
      { contentType: "application/json" },
    );
  });
  const ticketRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scopes = bearerScopes(request);
    if (scopes === undefined) return HttpServerResponse.text("Unauthorized", { status: 401 });
    issued += 1;
    const ticket = `ticket-${issued}`;
    tickets.set(ticket, scopes);
    return HttpServerResponse.text(encodeWebSocketTicket({ ticket, expiresAt }), {
      contentType: "application/json",
    });
  });
  const boardGate = (scope: string) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const scopes = bearerScopes(request);
      if (scopes === undefined) return yield* Effect.fail("unauthorized" as const);
      if (!scopes.includes(scope)) return yield* Effect.fail("forbidden" as const);
    });
  const boardResponse = <A, R>(effect: Effect.Effect<A, "unauthorized" | "forbidden", R>) =>
    effect.pipe(
      Effect.catch((reason) =>
        Effect.succeed(
          HttpServerResponse.text(reason === "forbidden" ? "Forbidden" : "Unauthorized", {
            status: reason === "forbidden" ? 403 : 401,
          }),
        ),
      ),
    );
  const boardGet = boardResponse(
    Effect.gen(function* () {
      yield* boardGate(AuthOrchestrationReadScope);
      return HttpServerResponse.text(hub.snapshot(), { contentType: "application/json" });
    }),
  );
  const boardPost = boardResponse(
    Effect.gen(function* () {
      yield* boardGate(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const written = hub.upsert(text);
      if (written === "invalid") return HttpServerResponse.text("Invalid board.", { status: 400 });
      if (written !== "ok") {
        return HttpServerResponse.text(JSON.stringify({ detail: written }), {
          status: 409,
          contentType: "application/json",
        });
      }
      return HttpServerResponse.text(hub.snapshot(), {
        status: 200,
        contentType: "application/json",
      });
    }),
  );
  const boardEvents = boardResponse(
    Effect.gen(function* () {
      yield* boardGate(AuthOrchestrationReadScope);
      return yield* hub.events;
    }),
  );
  const wsRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const protocol = Option.isSome(requestUrl)
      ? requestUrl.value.searchParams.get("orchestrationProtocol")
      : null;
    if (protocol !== ORCHESTRATION_PROTOCOL_VERSION_TEXT) {
      return HttpServerResponse.text("Upgrade Required", { status: 426 });
    }
    const ticket = Option.isSome(requestUrl) ? requestUrl.value.searchParams.get("wsTicket") : null;
    const scopes = ticket === null || ticket.length === 0 ? undefined : tickets.get(ticket);
    if (scopes === undefined || ticket === null) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    tickets.delete(ticket);
    const upgraded = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(T3OrchestrationRpc).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(RpcServer.Protocol, upgraded.protocol),
          handlersLayer,
          authorizationFor(scopes),
          RpcSerialization.layerJson,
        ),
      ),
      Effect.forkScoped,
    );
    return yield* upgraded.httpEffect;
  }).pipe(Effect.provide(RpcSerialization.layerJson));
  const layer = HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("POST", "/oauth/token", tokenRoute),
      HttpRouter.add("POST", "/api/auth/websocket-ticket", ticketRoute),
      HttpRouter.add("GET", "/ws", wsRoute),
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, boardGet),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, boardPost),
      HttpRouter.add(
        "POST",
        ADAPTER_BOARD_EVENT_PATH,
        boardResponse(
          Effect.gen(function* () {
            yield* boardGate(AuthOrchestrationOperateScope);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
            const result = yield* acceptBoardEvent(hub, ledger, text, CLOCK);
            ledger = result.ledger;
            return HttpServerResponse.text(result.body, {
              status: result.status,
              contentType: "application/json",
            });
          }),
        ),
      ),
      HttpRouter.add("GET", ADAPTER_BOARD_EVENTS_PATH, boardEvents),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(RpcSerialization.layerJson),
  );
  const fake = (origin: string): FakeT3 => ({
    origin,
    launchCount: () => launches,
    interruptCount: () => interrupts.size,
    continueCount: () => continues.size,
    threadCount: () => threads.size,
    prompt: (threadId) => threads.get(threadId)?.prompt ?? "",
    requirements: (threadId) => threads.get(threadId)?.requirements ?? "",
    hasContext: (threadId) => threads.get(threadId)?.hasContext === true,
    model: (threadId) => threads.get(threadId)?.model ?? "",
    instanceId: (threadId) => threads.get(threadId)?.instanceId ?? "",
    workspace: (threadId) => threads.get(threadId)?.workspace ?? "",
    runId: (threadId) => threads.get(threadId)?.runId ?? "",
    continuedRunId: (threadId) => continues.get(threadId),
    interruptedRunId: (threadId) => interrupts.get(threadId),
    setThread: (threadId, patch) => {
      const current = threads.get(threadId);
      if (current === undefined) throw new Error(`Missing ${threadId}`);
      threads.set(threadId, { ...current, ...patch });
    },
  });
  return { layer, fake };
};

const withFake = <A, E, R>(use: (fake: FakeT3) => Effect.Effect<A, E, R>) => {
  const server = makeFake();
  return Effect.gen(function* () {
    clearAdapterBoard();
    const formatted = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
    const url = new URL(formatted);
    // layerTest listens on the unspecified address, which a websocket cannot dial.
    if (url.hostname === "[::]" || url.hostname === "::" || url.hostname === "0.0.0.0") {
      url.hostname = "127.0.0.1";
    }
    return yield* use(server.fake(url.origin));
  }).pipe(Effect.provide(server.layer));
};

const t3Client = (origin: string, pairingToken = PAIR_OPERATE) =>
  wsT3LocalClient({ origin, pairingToken });

const authedText = (origin: string, path: string, token: string) =>
  HttpClient.execute(
    HttpClientRequest.get(`${origin}${path}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      path === ADAPTER_BOARD_EVENTS_PATH
        ? response.stream.pipe(
            Stream.decodeText,
            Stream.take(1),
            Stream.runFold(
              () => "",
              (left, right) => left + right,
            ),
          )
        : response.text,
    ),
    Effect.provide(FetchHttpClient.layer),
  );

const accessTokenFor = (origin: string, pairingToken: string) =>
  HttpClient.execute(
    HttpClientRequest.post(`${origin}/oauth/token`).pipe(
      HttpClientRequest.bodyText(
        new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: pairingToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`,
        }).toString(),
        "application/x-www-form-urlencoded",
      ),
    ),
  ).pipe(
    Effect.flatMap((response) => response.text),
    Effect.flatMap(decodeAccessToken),
    Effect.map((token) => token.access_token),
    Effect.provide(FetchHttpClient.layer),
  );

const context = assignmentExample.contextPackage;
const TEST_MODEL = "gpt-5.6-sol";

const record = (
  adapter: ReturnType<typeof createGrokT3Adapter>,
  taskId = "task-usba-page",
  intake: unknown = intakeV2Example,
  title = "Tournament page",
) =>
  adapter.record({
    taskId,
    title,
    intake,
    context,
  });

it.effect("fingerprints the provider launch will use", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const client = t3Client(fake.origin);
      const grok = createGrokT3Adapter({
        client,
        clock: () => CLOCK,
        instanceId: "grok",
        model: "gpt-5.4",
      });
      const codex = createGrokT3Adapter({
        client,
        clock: () => CLOCK,
        instanceId: "codex",
        model: "gpt-5.4",
      });
      const grokRecorded = yield* record(grok, "task-grok-page");
      const codexRecorded = yield* record(codex, "task-codex-page");
      assert.notStrictEqual(grokRecorded.launchKey, codexRecorded.launchKey);

      const started = yield* grok.launch(grokRecorded.taskId);
      assert.strictEqual(started.threadId, "t3-thread-1");
      assert.strictEqual(fake.instanceId("t3-thread-1"), "grok");
      assert.strictEqual(fake.model("t3-thread-1"), "gpt-5.4");
    }),
  ),
);

it.effect("does not invent gpt-5.4 when no model is selected", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
      });
      const failed = yield* record(adapter).pipe(Effect.flip);
      assert.strictEqual(failed.reason, "invalid_task");
      assert.equal(failed.detail.includes("gpt-5.4"), false);
      assert.strictEqual(fake.launchCount(), 0);
    }),
  ),
);

it.effect("launches one T3 thread and reads the completion back", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      assert.strictEqual(recorded.state.phase, "assigned");
      assert.strictEqual(fake.launchCount(), 0);

      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.state.phase, "executing");
      assert.strictEqual(started.threadId, "t3-thread-1");
      assert.strictEqual(started.runId, "run-1");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.threadCount(), 1);
      assert.equal(fake.prompt("t3-thread-1").includes(intakeV2Example.request), true);
      assert.strictEqual(fake.requirements("t3-thread-1"), context.requirements);
      assert.strictEqual(fake.hasContext("t3-thread-1"), true);
      assert.strictEqual(fake.model("t3-thread-1"), TEST_MODEL);
      assert.strictEqual(fake.workspace("t3-thread-1"), "root");

      yield* adapter.launch(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);

      fake.setThread("t3-thread-1", { inputTokens: 12, outputTokens: 3 });
      const working = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(working.state.phase, "executing");
      if (working.state.phase !== "executing") return;
      assert.strictEqual(working.state.run.progress?.status, "working");
      assert.strictEqual(working.state.run.usage.length, 1);
      assert.strictEqual(working.state.run.usage[0]?.kind, "reported_tokens");
      const again = yield* adapter.observe(recorded.taskId);
      if (again.state.phase !== "executing") return;
      assert.strictEqual(again.state.run.usage.length, 1);

      const stale = yield* adapter
        .reportProgress(recorded.taskId, {
          version: "v1",
          taskId: recorded.taskId,
          attemptId: `${recorded.taskId}-attempt-1`,
          generation: 2,
          leaseId: leaseIdFor(2),
          status: "working",
          blockers: [],
          partialArtifacts: [],
        })
        .pipe(Effect.flip);
      assert.strictEqual(stale.reason, "stale_generation");

      fake.setThread("t3-thread-1", {
        status: "completed",
        text: "Published the tournament page.",
        revision: SHA,
      });
      const done = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(done.state.phase, "awaiting_qa");
      if (done.state.phase !== "awaiting_qa") return;
      assert.strictEqual(done.state.completion.generation, 1);
      assert.strictEqual(done.state.completion.leaseId, leaseIdFor(1));
      assert.strictEqual(done.state.completion.claimedOutcome, "Published the tournament page.");
      assert.deepStrictEqual(done.state.completion.evidence, [
        { kind: "readback", ref: "thread:t3-thread-1" },
      ]);
      yield* decodeIntake(done.state.intake);
      yield* decodeAssignmentV1(done.state.assignment);
      yield* decodeCompletionSubmissionV1(done.state.completion);
      yield* decodeSequenceState(done.state);
      yield* adapter.observe(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);

      const card = adapter.result(recorded.taskId);
      assert.strictEqual(card?.threadId, "t3-thread-1");
      assert.strictEqual(readAdapterBoard().length, 1);
    }),
  ),
);

it.effect("continues an interrupted run on the same thread", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const store = memorySessionStore();
      const client = t3Client(fake.origin);
      const adapter = createGrokT3Adapter({
        client,
        clock: () => CLOCK,
        store,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.threadId, "t3-thread-1");
      fake.setThread("t3-thread-1", { status: "interrupted" });
      const blocked = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(blocked.state.phase, "recovery_pending");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.continueCount(), 0);

      const resumed = yield* adapter.recover(recorded.taskId);
      assert.strictEqual(resumed.state.phase, "executing");
      assert.strictEqual(resumed.threadId, "t3-thread-1");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.threadCount(), 1);
      assert.strictEqual(fake.continueCount(), 1);
      assert.strictEqual(fake.continuedRunId("t3-thread-1"), started.runId);
      assert.strictEqual(resumed.runId, `run-continued-${started.runId}`);
      if (resumed.state.phase !== "executing") return;
      assert.strictEqual(resumed.state.run.generation, 2);
      assert.strictEqual(resumed.state.run.progress, null);

      yield* adapter.recover(recorded.taskId);
      assert.strictEqual(fake.continueCount(), 1);

      fake.setThread("t3-thread-1", {
        status: "completed",
        text: "Finished after the lapse.",
        revision: SHA,
      });
      const done = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(done.state.phase, "awaiting_qa");
      if (done.state.phase !== "awaiting_qa") return;
      assert.strictEqual(done.state.completion.generation, 2);
      assert.strictEqual(done.state.completion.leaseId, leaseIdFor(2));
      assert.strictEqual(done.state.completion.claimedOutcome, "Finished after the lapse.");
    }),
  ),
);

it.effect("reuses the server thread when the local record lost the id", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const store = memorySessionStore();
      const client = t3Client(fake.origin);
      const adapter = createGrokT3Adapter({
        client,
        clock: () => CLOCK,
        store,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const request = {
        idempotencyKey: recorded.launchKey,
        projectId: intakeV2Example.projectId,
        title: recorded.title,
        prompt: "already sent",
        contextPackage: context,
        model: "gpt-5.4",
      };
      const first = yield* client.launch(request);
      assert.strictEqual(first.resumed, false);
      const second = yield* client.launch(request);
      assert.strictEqual(second.resumed, true);
      assert.strictEqual(second.threadId, first.threadId);
      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.threadId, first.threadId);
      assert.strictEqual(fake.threadCount(), 1);
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("interrupts the run once when cancel is repeated", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const started = yield* adapter.launch(recorded.taskId);
      const cancelled = yield* adapter.cancel(recorded.taskId);
      assert.strictEqual(cancelled.state.phase, "cancelled");
      assert.strictEqual(fake.interruptedRunId("t3-thread-1"), started.runId);
      yield* adapter.cancel(recorded.taskId);
      assert.strictEqual(fake.interruptCount(), 1);
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("does not mark the task cancelled when the interrupt fails", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const base = t3Client(fake.origin);
      const adapter = createGrokT3Adapter({
        client: {
          ...base,
          interrupt: () =>
            Effect.fail(new GrokT3Error({ reason: "t3_rejected", detail: "The run stayed up." })),
        },
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.state.phase, "executing");
      const failed = yield* adapter.cancel(recorded.taskId).pipe(Effect.flip);
      assert.strictEqual(failed.reason, "t3_rejected");
      assert.strictEqual(adapter.result(recorded.taskId)?.state.phase, "executing");
      const paused = yield* adapter.pause(recorded.taskId).pipe(Effect.flip);
      assert.strictEqual(paused.reason, "t3_rejected");
      assert.strictEqual(adapter.result(recorded.taskId)?.state.phase, "executing");
    }),
  ),
);

it.effect("pauses only after the interrupt and does not start when launch fails", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const early = yield* adapter.cancel(recorded.taskId).pipe(Effect.flip);
      assert.strictEqual(early.reason, "not_started");
      assert.strictEqual(adapter.result(recorded.taskId)?.state.phase, "assigned");

      const started = yield* adapter.launch(recorded.taskId);
      const paused = yield* adapter.pause(started.taskId);
      assert.strictEqual(paused.state.phase, "recovery_pending");
      assert.strictEqual(fake.interruptCount(), 1);

      const blockedLaunch = createGrokT3Adapter({
        client: {
          ...t3Client(fake.origin),
          launch: () =>
            Effect.fail(new GrokT3Error({ reason: "t3_rejected", detail: "No thread." })),
        },
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      const held = yield* record(blockedLaunch, "task-held");
      const missed = yield* blockedLaunch.launch(held.taskId).pipe(Effect.flip);
      assert.strictEqual(missed.reason, "t3_rejected");
      assert.strictEqual(blockedLaunch.result(held.taskId)?.state.phase, "assigned");
    }),
  ),
);

it.effect("refuses a changed title and an undeclared capability", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      yield* record(adapter);
      const conflict = yield* record(
        adapter,
        "task-usba-page",
        intakeV2Example,
        "Renamed page",
      ).pipe(Effect.flip);
      assert.strictEqual(conflict.reason, "idempotency_conflict");
      const same = yield* record(adapter);
      assert.strictEqual(same.state.phase, "assigned");
      assert.strictEqual(fake.launchCount(), 0);

      assert.deepStrictEqual(
        [...adapter.capabilities].sort(),
        Object.keys(adapter.operations).sort(),
      );
      for (const capability of adapter.capabilities) {
        assert.strictEqual(typeof adapter.operations[capability], "function");
      }
      assert.strictEqual(Object.hasOwn(adapter.operations, "retrieve_assignments"), false);
      const missing = yield* requireCapability(adapter, "retrieve_assignments").pipe(Effect.flip);
      assert.strictEqual(missing.reason, "unsupported");

      const session = { ok: true } as const;
      const jira: WorkerAdapter<typeof session> = {
        id: "jira",
        capabilities: new Set(["report_status"]),
        operations: {
          report_status: (taskId) => jira.observe(taskId),
        },
        launch: () => requireCapability(jira, "start").pipe(Effect.as(session)),
        observe: () => requireCapability(jira, "report_status").pipe(Effect.as(session)),
        cancel: () => requireCapability(jira, "cancel").pipe(Effect.as(session)),
        recover: () => requireCapability(jira, "resume").pipe(Effect.as(session)),
        result: () => null,
      };
      assert.deepStrictEqual([...jira.capabilities], Object.keys(jira.operations));
      const unsupported = yield* jira.launch("task-usba-page").pipe(Effect.flip);
      assert.strictEqual(unsupported.reason, "unsupported");
      const reportStatus = jira.operations.report_status;
      if (reportStatus === undefined) return yield* Effect.die("report_status is missing");
      yield* reportStatus("task-usba-page");
      yield* requireCapability(adapter, "idempotency");
      yield* requireCapability(adapter, "receive_context");
    }),
  ),
);

it.effect("rejects an unauthenticated socket and a read-only launch", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const open = yield* HttpClient.execute(
        HttpClientRequest.get(`${fake.origin}/ws?orchestrationProtocol=2`),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(open.status, 401);
      const bogus = yield* HttpClient.execute(
        HttpClientRequest.get(`${fake.origin}/ws?orchestrationProtocol=2&wsTicket=missing`),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(bogus.status, 401);

      const rejected = yield* t3Client(fake.origin, "missing")
        .launch({
          idempotencyKey: "missing",
          projectId: intakeV2Example.projectId,
          title: "Nope",
          prompt: "Nope",
          contextPackage: context,
          model: "gpt-5.4",
        })
        .pipe(Effect.flip);
      assert.strictEqual(rejected.reason, "unauthenticated");

      const store = memorySessionStore();
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        store,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const readOnly = createGrokT3Adapter({
        client: t3Client(fake.origin, PAIR_READ),
        clock: () => CLOCK,
        store,
        model: TEST_MODEL,
      });
      const denied = yield* readOnly.launch(recorded.taskId).pipe(Effect.flip);
      assert.strictEqual(denied.reason, "t3_rejected");
      assert.equal(denied.detail.includes(AuthOrchestrationOperateScope), true);
      assert.strictEqual(fake.launchCount(), 0);
    }),
  ),
);

it.effect("invokes every advertised capability", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      const recorded = yield* record(adapter);
      const receiveContext = adapter.operations.receive_context;
      const reportUsage = adapter.operations.report_usage;
      const heartbeat = adapter.operations.heartbeat;
      const idempotency = adapter.operations.idempotency;
      if (
        receiveContext === undefined ||
        reportUsage === undefined ||
        heartbeat === undefined ||
        idempotency === undefined
      ) {
        return yield* Effect.die("advertised capability is missing");
      }
      const received = yield* receiveContext(recorded.taskId);
      assert.strictEqual(received.requirements, context.requirements);
      const start = adapter.operations.start;
      if (start === undefined) return yield* Effect.die("start is missing");
      const started = yield* start(recorded.taskId);
      if (started.state.phase !== "executing") {
        return yield* Effect.die("start did not reach executing");
      }
      const reported = yield* reportUsage(recorded.taskId, {
        kind: "reported_tokens",
        inputTokens: 4,
        outputTokens: 2,
        attribution: {
          projectId: intakeV2Example.projectId,
          taskId: recorded.taskId,
          attemptId: `${recorded.taskId}-attempt-1`,
          agentId: "codex-t3",
          platform: "t3",
          provider: "openai",
          model: { model: "gpt-5.4" },
        },
      });
      if (reported.state.phase !== "executing") return;
      assert.strictEqual(reported.state.run.usage.length, 1);
      assert.strictEqual(reported.state.run.usage[0]?.kind, "reported_tokens");
      const alive = yield* heartbeat(recorded.taskId, CLOCK, "2026-10-21T18:05:00.000Z");
      if (alive.state.phase !== "executing") return;
      assert.strictEqual(alive.state.run.leaseExpiresAt, "2026-10-21T18:05:00.000Z");
      const same = yield* idempotency(recorded.taskId, recorded.launchKey);
      assert.strictEqual(same.taskId, recorded.taskId);
      const conflict = yield* idempotency(recorded.taskId, "different-payload").pipe(Effect.flip);
      assert.strictEqual(conflict.reason, "idempotency_conflict");
      assert.strictEqual(adapter.result(recorded.taskId)?.taskId, recorded.taskId);
    }),
  ),
);

it.effect("publishes board cards on the T3 origin", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const denied = yield* HttpClient.execute(
        HttpClientRequest.get(`${fake.origin}${ADAPTER_BOARD_PATH}`),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(denied.status, 401);
      const deniedEvents = yield* HttpClient.execute(
        HttpClientRequest.get(`${fake.origin}${ADAPTER_BOARD_EVENTS_PATH}`),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(deniedEvents.status, 401);

      const adapter = createGrokT3Adapter({
        client: t3Client(fake.origin),
        clock: () => CLOCK,
        model: TEST_MODEL,
      });
      yield* record(adapter);
      const token = yield* accessTokenFor(fake.origin, PAIR_OPERATE);
      const snapshot = decodeAdapterBoard(
        yield* authedText(fake.origin, ADAPTER_BOARD_PATH, token),
      );
      assert.strictEqual(snapshot?.length, 1);
      assert.strictEqual(snapshot?.[0]?.taskId, "task-usba-page");
      const events = yield* authedText(fake.origin, ADAPTER_BOARD_EVENTS_PATH, token);
      assert.equal(events.includes("task-usba-page"), true);
      yield* record(adapter, "task-usba-scores");
      const next = decodeAdapterBoard(yield* authedText(fake.origin, ADAPTER_BOARD_PATH, token));
      assert.strictEqual(next?.length, 2);
      assert.strictEqual(readAdapterBoard().length, 2);
    }),
  ),
);
