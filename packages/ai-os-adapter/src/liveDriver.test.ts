import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import type { KanbanMoveLedger } from "@t3tools/ai-os-contracts";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

import { ADAPTER_BOARD_EVENT_PATH, ADAPTER_BOARD_PATH, decodeAdapterBoard } from "./board.ts";
import { acceptBoardEvent, makeAdapterBoardHub } from "./boardHub.ts";
import {
  LIVE_DRIVER_COMMAND,
  LIVE_DRIVER_DEFAULT_ORIGIN,
  LIVE_DRIVER_HELP,
  LiveDriverUsageError,
  isLoopbackDriverOrigin,
  parseLiveDriverArgs,
  resolveDriverModel,
  runLiveDriver,
  runLiveDriverCli,
} from "./liveDriver.ts";
import {
  readProviderCatalog,
  wsT3LocalClient,
  type T3LaunchRequest,
  type T3LocalClient,
  type T3ModelCatalog,
} from "./t3Client.ts";

const isLiveDriverUsageError = Schema.is(LiveDriverUsageError);

const CLOCK = "2026-10-21T18:00:00.000Z";
const SHA = "ab".repeat(20);
const PAIR = "pair-operate";

const encodeAccessToken = Schema.encodeSync(Schema.fromJsonString(AuthAccessTokenResult));
const decodeAccessToken = Schema.decodeUnknownEffect(Schema.fromJsonString(AuthAccessTokenResult));

const formField = (params: UrlParams.UrlParams, key: string) => {
  const value = UrlParams.getFirst(params, key);
  return Option.isSome(value) ? value.value : undefined;
};

const makeServer = () => {
  const hub = makeAdapterBoardHub();
  let ledger: KanbanMoveLedger = {};
  const bearers = new Map<string, readonly string[]>();
  let issued = 0;
  let exchanges = 0;
  const scopesFor = (request: HttpServerRequest.HttpServerRequest) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || header.trim().length === 0) {
      return [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
    }
    if (!header.startsWith("Bearer ")) return undefined;
    return bearers.get(header.slice("Bearer ".length).trim());
  };
  const tokenRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* request.urlParamsBody.pipe(
      Effect.orElseSucceed(() => UrlParams.make([])),
    );
    if (
      formField(params, "grant_type") !== AuthTokenExchangeGrantType ||
      formField(params, "subject_token") !== PAIR ||
      formField(params, "subject_token_type") !== AuthEnvironmentBootstrapTokenType ||
      formField(params, "requested_token_type") !== AuthAccessTokenType
    ) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    issued += 1;
    exchanges += 1;
    const accessToken = `access-${issued}`;
    bearers.set(accessToken, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    return HttpServerResponse.text(
      encodeAccessToken({
        access_token: accessToken,
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: 3600,
        scope: `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`,
      }),
      { contentType: "application/json" },
    );
  });
  const projectsRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scopes = scopesFor(request);
    if (scopes === undefined || !scopes.includes(AuthOrchestrationReadScope)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    return HttpServerResponse.text(
      JSON.stringify({
        projects: [
          {
            id: "usba",
            title: "USBA",
            workspaceRoot: "/work/usba",
            deletedAt: null,
            scripts: [],
            defaultModelSelection: {
              instanceId: "codex",
              model: "gpt-5.6-sol",
              options: { reasoning: "low" },
            },
          },
          {
            id: "retired",
            title: "Retired",
            workspaceRoot: "/work/retired",
            deletedAt: CLOCK,
          },
        ],
        updatedAt: CLOCK,
      }),
      { contentType: "application/json" },
    );
  });
  const boardGet = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scopes = scopesFor(request);
    if (scopes === undefined || !scopes.includes(AuthOrchestrationReadScope)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    return HttpServerResponse.text(hub.snapshot(), { contentType: "application/json" });
  });
  const boardPost = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scopes = scopesFor(request);
    if (scopes === undefined || !scopes.includes(AuthOrchestrationOperateScope)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
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
  });
  const layer = HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("POST", "/oauth/token", tokenRoute),
      HttpRouter.add("GET", "/api/projects", projectsRoute),
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, boardGet),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, boardPost),
      HttpRouter.add(
        "POST",
        ADAPTER_BOARD_EVENT_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const scopes = scopesFor(request);
          if (scopes === undefined || !scopes.includes(AuthOrchestrationOperateScope)) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
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
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
  return { layer, exchanges: () => exchanges };
};

const withServer = <A, E, R>(
  use: (origin: string, exchanges: () => number) => Effect.Effect<A, E, R>,
) => {
  const server = makeServer();
  return Effect.gen(function* () {
    const formatted = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
    const url = new URL(formatted);
    if (url.hostname === "[::]" || url.hostname === "::" || url.hostname === "0.0.0.0") {
      url.hostname = "127.0.0.1";
    }
    return yield* use(url.origin, server.exchanges);
  }).pipe(Effect.provide(server.layer));
};

const CATALOG: T3ModelCatalog = {
  providers: [
    {
      instanceId: "codex",
      models: [
        { slug: "gpt-5.6-sol", aliases: [], isDefault: false },
        { slug: "gpt-6-sol", aliases: ["sol"], isDefault: true },
      ],
    },
  ],
  serverDefault: null,
};

const readBoard = (origin: string) =>
  HttpClient.execute(
    HttpClientRequest.post(`${origin}/oauth/token`).pipe(
      HttpClientRequest.bodyText(
        new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: PAIR,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }).toString(),
        "application/x-www-form-urlencoded",
      ),
    ),
  ).pipe(
    Effect.flatMap((response) => response.text),
    Effect.flatMap(decodeAccessToken),
    Effect.flatMap((token) =>
      HttpClient.execute(
        HttpClientRequest.get(`${origin}${ADAPTER_BOARD_PATH}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token.access_token}`),
        ),
      ),
    ),
    Effect.flatMap((response) => response.text),
    Effect.provide(FetchHttpClient.layer),
  );

it.effect("reads the pairing token from the environment and rejects the flag", () =>
  Effect.sync(() => {
    const parsed = parseLiveDriverArgs(
      ["--", "--origin", "http://127.0.0.1:13773/", "--title", "Tournament page"],
      { T3_PAIRING_TOKEN: " env-token " },
    );
    assert.strictEqual(parsed.origin, LIVE_DRIVER_DEFAULT_ORIGIN);
    assert.strictEqual(parsed.pairingToken, "env-token");
    assert.strictEqual(parsed.model, undefined);
    assert.strictEqual(parsed.projectId, undefined);

    const missing = parseLiveDriverArgs(["--project-id", "usba"], {});
    assert.strictEqual(missing.pairingToken, undefined);
    assert.equal(LIVE_DRIVER_HELP.includes("gpt-5.4"), false);
    assert.equal(isLoopbackDriverOrigin(LIVE_DRIVER_DEFAULT_ORIGIN), true);
    assert.equal(isLoopbackDriverOrigin("http://[::1]:13773"), true);
    assert.equal(isLoopbackDriverOrigin("http://127.8.8.8:13773"), true);
    assert.equal(isLoopbackDriverOrigin("http://10.1.2.3:13773"), false);

    const secret = "pair-secret-value";
    let rejected = false;
    let rejectedDetail = "";
    try {
      parseLiveDriverArgs(["--pairing-token", secret, "--project-id", "usba"], {
        T3_PAIRING_TOKEN: "env-token",
      });
    } catch (error) {
      rejected = isLiveDriverUsageError(error);
      if (isLiveDriverUsageError(error)) rejectedDetail = error.detail;
    }
    assert.strictEqual(rejected, true);
    assert.equal(rejectedDetail.includes(secret), false);
    assert.equal(LIVE_DRIVER_HELP.includes("--pairing-token"), false);
    assert.equal(LIVE_DRIVER_HELP.includes("vp run"), false);
    assert.equal(LIVE_DRIVER_HELP.includes(LIVE_DRIVER_COMMAND), true);

    let inline = false;
    let inlineDetail = "";
    try {
      parseLiveDriverArgs([`--pairing-token=${secret}`], { T3_PAIRING_TOKEN: "env-token" });
    } catch (error) {
      inline = isLiveDriverUsageError(error);
      if (isLiveDriverUsageError(error)) inlineDetail = error.detail;
    }
    assert.strictEqual(inline, true);
    assert.equal(inlineDetail.includes(secret), false);
  }),
);

it.effect("prints help and requires a token only for a remote origin", () =>
  Effect.gen(function* () {
    const unusedCommit = () => Promise.resolve(SHA);
    assert.strictEqual(
      yield* Effect.promise(() => runLiveDriverCli(["--help"], {}, unusedCommit)),
      0,
    );
    assert.strictEqual(
      yield* Effect.promise(() =>
        runLiveDriverCli(
          ["--origin", "http://10.1.2.3:13773", "--list-projects"],
          {},
          unusedCommit,
        ),
      ),
      1,
    );
  }),
);

it.effect("lists project ids and publishes the launched task to the server board", () =>
  withServer((origin) =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const write = (line: string) => {
        lines.push(line);
      };
      const listed = yield* runLiveDriver(
        {
          origin,
          pairingToken: PAIR,
          projectId: undefined,
          model: undefined,
          title: undefined,
          prompt: undefined,
          listProjects: true,
        },
        {
          client: wsT3LocalClient({ origin, pairingToken: PAIR }),
          clock: () => CLOCK,
          write,
          sleep: () => Effect.void,
          readRepoCommit: () => Promise.resolve(SHA),
        },
      );
      assert.strictEqual(listed, undefined);
      assert.deepStrictEqual(lines, ["usba\tUSBA"]);

      let launched: T3LaunchRequest | undefined;
      let reads = 0;
      const real = wsT3LocalClient({ origin, pairingToken: PAIR });
      const client: T3LocalClient = {
        listProjectIds: real.listProjectIds,
        listProviderModels: () => Effect.succeed(CATALOG),
        publishBoard: real.publishBoard,
        publishEvent: real.publishEvent,
        readBoard: real.readBoard,
        interrupt: () => Effect.die("interrupt is unused"),
        continueRun: () => Effect.die("continue is unused"),
        launch: (input) => {
          launched = input;
          return Effect.succeed({ threadId: "t3-thread-1", runId: "run-1", resumed: false });
        },
        read: () => {
          reads += 1;
          return Effect.succeed({
            threadId: "t3-thread-1",
            runId: "run-1",
            status: reads < 4 ? "running" : "completed",
            text: reads < 4 ? "draft" : "done",
            revision: null,
          });
        },
      };
      const progress: string[] = [];
      yield* runLiveDriver(
        {
          origin,
          pairingToken: PAIR,
          projectId: "usba",
          model: undefined,
          title: "Tournament page",
          prompt: "Update the tournament page schedule.",
          listProjects: false,
        },
        {
          client,
          clock: () => CLOCK,
          write: (line) => {
            progress.push(line);
          },
          sleep: () => Effect.void,
          readRepoCommit: (workspaceRoot) => {
            assert.strictEqual(workspaceRoot, "/work/usba");
            return Promise.resolve(SHA);
          },
          pollIntervalMs: 0,
          maxPolls: 5,
        },
      );

      assert.strictEqual(launched?.projectId, "usba");
      assert.strictEqual(launched?.model, "gpt-5.6-sol");
      assert.strictEqual(launched?.instanceId, "codex");
      assert.strictEqual(launched?.title, "Tournament page");
      assert.equal(launched?.prompt.includes("Update the tournament page schedule."), true);
      assert.deepStrictEqual(progress, [
        "task live-tournament-page-20261021t180000z",
        "thread t3-thread-1",
        "draft",
        "executing working",
        "done",
        "awaiting_qa",
      ]);

      const snapshot = decodeAdapterBoard(yield* readBoard(origin));
      assert.equal(snapshot !== null && snapshot.length === 1, true);
      assert.strictEqual(snapshot?.[0]?.taskId, "live-tournament-page-20261021t180000z");
      assert.strictEqual(snapshot?.[0]?.title, "Tournament page");
      assert.strictEqual(snapshot?.[0]?.threadId, "t3-thread-1");
      const state = snapshot?.[0]?.state as { phase?: string };
      assert.strictEqual(state.phase, "awaiting_qa");
    }),
  ),
);

it.effect("lists loopback projects without exchanging a pairing token", () =>
  withServer((origin, exchanges) =>
    Effect.gen(function* () {
      const lines: string[] = [];
      yield* runLiveDriver(
        {
          origin,
          pairingToken: undefined,
          projectId: undefined,
          model: undefined,
          title: undefined,
          prompt: undefined,
          listProjects: true,
        },
        {
          client: wsT3LocalClient({ origin }),
          clock: () => CLOCK,
          write: (line) => {
            lines.push(line);
          },
          sleep: () => Effect.void,
          readRepoCommit: () => Promise.resolve(SHA),
        },
      );
      assert.deepStrictEqual(lines, ["usba\tUSBA"]);
      assert.strictEqual(exchanges(), 0);

      const withToken = yield* wsT3LocalClient({ origin, pairingToken: PAIR }).listProjectIds();
      assert.strictEqual(exchanges(), 1);
      assert.strictEqual(withToken[0]?.id, "usba");
    }),
  ),
);

it.effect("lists projects and launches in one run", () =>
  Effect.gen(function* () {
    const lines: string[] = [];
    let launches = 0;
    const client: T3LocalClient = {
      listProjectIds: () =>
        Effect.succeed([
          {
            id: "usba",
            title: "USBA",
            workspaceRoot: "/work/usba",
            defaultModel: { instanceId: "codex", model: "gpt-5.6-sol" },
          },
        ]),
      listProviderModels: () => Effect.succeed(CATALOG),
      publishBoard: (cards) =>
        Effect.succeed(cards.map((card) => ({ ...card, revision: (card.revision ?? 0) + 1 }))),
      publishEvent: () => Effect.succeed({ revision: 1 }),
      readBoard: () => Effect.succeed([]),
      interrupt: () => Effect.die("interrupt is unused"),
      continueRun: () => Effect.die("continue is unused"),
      launch: () => {
        launches += 1;
        return Effect.succeed({ threadId: "t3-thread-1", runId: "run-1", resumed: false });
      },
      read: () =>
        Effect.succeed({
          threadId: "t3-thread-1",
          runId: "run-1",
          status: "completed",
          text: "done",
          revision: null,
        }),
    };
    yield* runLiveDriver(
      {
        origin: LIVE_DRIVER_DEFAULT_ORIGIN,
        pairingToken: PAIR,
        projectId: "usba",
        model: undefined,
        title: "Tournament page",
        prompt: "Update the tournament page schedule.",
        listProjects: true,
      },
      {
        client,
        clock: () => CLOCK,
        write: (line) => {
          lines.push(line);
        },
        sleep: () => Effect.void,
        readRepoCommit: () => Promise.resolve(SHA),
        pollIntervalMs: 0,
        maxPolls: 3,
      },
    );
    assert.strictEqual(lines[0], "usba\tUSBA");
    assert.strictEqual(launches, 1);
    assert.equal(
      lines.some((line) => line.startsWith("task ")),
      true,
    );
  }),
);

it.effect("launches the offered default when the configured model is gpt-5.4", () =>
  Effect.gen(function* () {
    let launched = "";
    const client: T3LocalClient = {
      listProjectIds: () =>
        Effect.succeed([
          {
            id: "usba",
            title: "USBA",
            workspaceRoot: "/work/usba",
            defaultModel: { instanceId: "codex", model: "gpt-5.4" },
          },
        ]),
      listProviderModels: () =>
        Effect.succeed({
          ...CATALOG,
          serverDefault: { instanceId: "codex", model: "gpt-5.4" },
        }),
      publishBoard: (cards) =>
        Effect.succeed(cards.map((card) => ({ ...card, revision: (card.revision ?? 0) + 1 }))),
      publishEvent: () => Effect.succeed({ revision: 1 }),
      readBoard: () => Effect.succeed([]),
      interrupt: () => Effect.die("interrupt is unused"),
      continueRun: () => Effect.die("continue is unused"),
      launch: (input) => {
        launched = `${input.instanceId ?? ""} ${input.model}`;
        return Effect.succeed({ threadId: "t3-thread-1", runId: "run-1", resumed: false });
      },
      read: () =>
        Effect.succeed({
          threadId: "t3-thread-1",
          runId: "run-1",
          status: "completed",
          text: "done",
          revision: null,
        }),
    };
    yield* runLiveDriver(
      {
        origin: LIVE_DRIVER_DEFAULT_ORIGIN,
        pairingToken: PAIR,
        projectId: "usba",
        model: undefined,
        title: "Tournament page",
        prompt: "Update the tournament page schedule.",
        listProjects: false,
      },
      {
        client,
        clock: () => CLOCK,
        write: () => undefined,
        sleep: () => Effect.void,
        readRepoCommit: () => Promise.resolve(SHA),
        pollIntervalMs: 0,
        maxPolls: 3,
      },
    );
    assert.strictEqual(launched, "codex gpt-6-sol");
    assert.equal(launched.includes("gpt-5.4"), false);
  }),
);

it.effect("rejects a model the provider does not offer and lists the valid ones", () =>
  Effect.gen(function* () {
    let launches = 0;
    const client: T3LocalClient = {
      listProjectIds: () =>
        Effect.succeed([
          {
            id: "usba",
            title: "USBA",
            workspaceRoot: "/work/usba",
            defaultModel: null,
          },
        ]),
      listProviderModels: () => Effect.succeed(CATALOG),
      publishBoard: (cards) =>
        Effect.succeed(cards.map((card) => ({ ...card, revision: (card.revision ?? 0) + 1 }))),
      publishEvent: () => Effect.succeed({ revision: 1 }),
      readBoard: () => Effect.succeed([]),
      interrupt: () => Effect.die("interrupt is unused"),
      continueRun: () => Effect.die("continue is unused"),
      launch: () => {
        launches += 1;
        return Effect.succeed({ threadId: "t3-thread-1", runId: null, resumed: false });
      },
      read: () => Effect.die("read is unused"),
    };
    const failed = yield* Effect.exit(
      runLiveDriver(
        {
          origin: LIVE_DRIVER_DEFAULT_ORIGIN,
          pairingToken: PAIR,
          projectId: "usba",
          model: "gpt-5.4",
          title: "Tournament page",
          prompt: "Update the tournament page schedule.",
          listProjects: false,
        },
        {
          client,
          clock: () => CLOCK,
          write: () => undefined,
          sleep: () => Effect.void,
          readRepoCommit: () => Promise.resolve(SHA),
        },
      ),
    );
    assert.strictEqual(Exit.isFailure(failed), true);
    if (Exit.isFailure(failed)) {
      const detail = failed.cause.toString();
      assert.equal(detail.includes("gpt-5.4"), true);
      assert.equal(detail.includes("gpt-5.6-sol"), true);
      assert.equal(detail.includes("gpt-6-sol"), true);
      assert.equal(detail.includes(PAIR), false);
    }
    assert.strictEqual(launches, 0);
  }),
);

it.effect("resolves an omitted model from the server catalog", () =>
  Effect.sync(() => {
    const project = resolveDriverModel({
      requested: undefined,
      projectDefault: { instanceId: "codex", model: "gpt-5.6-sol" },
      catalog: CATALOG,
    });
    assert.deepStrictEqual(project, { instanceId: "codex", model: "gpt-5.6-sol" });

    const serverDefault = resolveDriverModel({
      requested: undefined,
      projectDefault: null,
      catalog: { ...CATALOG, serverDefault: { instanceId: "codex", model: "sol" } },
    });
    assert.deepStrictEqual(serverDefault, { instanceId: "codex", model: "gpt-6-sol" });

    const marked = resolveDriverModel({
      requested: undefined,
      projectDefault: null,
      catalog: CATALOG,
    });
    assert.deepStrictEqual(marked, { instanceId: "codex", model: "gpt-6-sol" });

    const missing = resolveDriverModel({
      requested: undefined,
      projectDefault: null,
      catalog: {
        providers: [
          {
            instanceId: "codex",
            models: [{ slug: "gpt-5.6-sol", aliases: [], isDefault: false }],
          },
        ],
        serverDefault: null,
      },
    });
    assert.deepStrictEqual(missing, { instanceId: "codex", model: "gpt-5.6-sol" });

    const stale = resolveDriverModel({
      requested: undefined,
      projectDefault: { instanceId: "codex", model: "gpt-5.4" },
      catalog: { ...CATALOG, serverDefault: { instanceId: "codex", model: "gpt-5.4" } },
    });
    assert.deepStrictEqual(stale, { instanceId: "codex", model: "gpt-6-sol" });

    const empty = resolveDriverModel({
      requested: "gpt-6-sol",
      projectDefault: null,
      catalog: { providers: [], serverDefault: null },
    });
    assert.deepStrictEqual(empty, { error: "The server reported no models for this provider." });

    const catalog = readProviderCatalog({
      providers: [
        {
          instanceId: "codex",
          enabled: true,
          models: [
            { slug: "gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
            { slug: "old", isLegacy: true, isCustom: false, capabilities: null },
          ],
        },
        {
          instanceId: "off",
          enabled: false,
          models: [{ slug: "hidden", isCustom: false, capabilities: null }],
        },
      ],
      settings: { defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } },
    });
    assert.deepStrictEqual(catalog, {
      providers: [
        {
          instanceId: "codex",
          models: [{ slug: "gpt-5.6-sol", aliases: [], isDefault: false }],
        },
      ],
      serverDefault: { instanceId: "codex", model: "gpt-5.6-sol" },
    });
  }),
);
