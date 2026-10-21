import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

import { ADAPTER_BOARD_PATH, decodeAdapterBoard } from "./board.ts";
import { makeAdapterBoardHub } from "./boardHub.ts";
import {
  LIVE_DRIVER_COMMAND,
  LIVE_DRIVER_DEFAULT_ORIGIN,
  LIVE_DRIVER_HELP,
  LiveDriverUsageError,
  parseLiveDriverArgs,
  runLiveDriver,
  runLiveDriverCli,
} from "./liveDriver.ts";
import { wsT3LocalClient, type T3LaunchRequest, type T3LocalClient } from "./t3Client.ts";

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
  const bearers = new Map<string, readonly string[]>();
  let issued = 0;
  const scopesFor = (request: HttpServerRequest.HttpServerRequest) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
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
    if (!hub.replace(text)) return HttpServerResponse.text("Invalid board.", { status: 400 });
    return HttpServerResponse.empty({ status: 204 });
  });
  const layer = HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("POST", "/oauth/token", tokenRoute),
      HttpRouter.add("GET", "/api/projects", projectsRoute),
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, boardGet),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, boardPost),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
  return { layer };
};

const withServer = <A, E, R>(use: (origin: string) => Effect.Effect<A, E, R>) => {
  const server = makeServer();
  return Effect.gen(function* () {
    const formatted = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
    const url = new URL(formatted);
    if (url.hostname === "[::]" || url.hostname === "::" || url.hostname === "0.0.0.0") {
      url.hostname = "127.0.0.1";
    }
    return yield* use(url.origin);
  }).pipe(Effect.provide(server.layer));
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
    assert.strictEqual(parsed.model, "gpt-5.4");
    assert.strictEqual(parsed.projectId, undefined);

    let missing = false;
    let missingDetail = "";
    try {
      parseLiveDriverArgs(["--project-id", "usba"], {});
    } catch (error) {
      missing = isLiveDriverUsageError(error);
      if (isLiveDriverUsageError(error)) missingDetail = error.detail;
    }
    assert.strictEqual(missing, true);
    assert.equal(missingDetail.startsWith("Set T3_PAIRING_TOKEN."), true);

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

it.effect("prints help and a missing token without opening a socket", () =>
  Effect.gen(function* () {
    const unusedCommit = () => Promise.resolve(SHA);
    assert.strictEqual(
      yield* Effect.promise(() => runLiveDriverCli(["--help"], {}, unusedCommit)),
      0,
    );
    assert.strictEqual(yield* Effect.promise(() => runLiveDriverCli([], {}, unusedCommit)), 1);
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
          model: "gpt-5.4",
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
        publishBoard: real.publishBoard,
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
            status: reads < 3 ? "running" : "completed",
            text: reads < 3 ? "draft" : "done",
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
          model: "gpt-5.4",
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
      assert.strictEqual(launched?.model, "gpt-5.4");
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
