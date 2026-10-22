import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as UrlParams from "effect/http/UrlParams";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { T3ConfigRpc, wsT3LocalClient } from "./t3Client.ts";

const CLOCK = "2026-10-21T18:00:00.000Z";
const NOW = DateTime.makeUnsafe(CLOCK);
const PAIR = "pair-models";
const encodeAccessToken = Schema.encodeSync(Schema.fromJsonString(AuthAccessTokenResult));
const encodeWebSocketTicket = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(AuthWebSocketTicketResult)),
);

const formField = (params: UrlParams.UrlParams, key: string) => {
  const value = UrlParams.getFirst(params, key);
  return Option.isSome(value) ? value.value : undefined;
};

const CONFIG = {
  providers: [
    {
      instanceId: "codex",
      enabled: true,
      models: [
        { slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: null },
        {
          slug: "gpt-5.6-sol",
          name: "Sol",
          isCustom: false,
          capabilities: null,
          isDefault: true,
        },
        { slug: "retired", name: "Retired", isCustom: false, capabilities: null, isLegacy: true },
      ],
    },
  ],
  settings: { defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } },
};

it.effect("reads provider models from server.getConfig", () =>
  Effect.gen(function* () {
    const formatted = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
    const url = new URL(formatted);
    if (url.hostname === "[::]" || url.hostname === "::" || url.hostname === "0.0.0.0") {
      url.hostname = "127.0.0.1";
    }
    const catalog = yield* wsT3LocalClient({
      origin: url.origin,
      pairingToken: PAIR,
    }).listProviderModels();
    assert.deepStrictEqual(
      catalog.providers[0]?.models.map((model) => model.slug),
      ["gpt-6-astra", "gpt-5.6-sol"],
    );
    assert.strictEqual(catalog.providers[0]?.models[1]?.isDefault, true);
    assert.deepStrictEqual(catalog.serverDefault, { instanceId: "codex", model: "gpt-5.6-sol" });
  }).pipe(
    Effect.provide(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add(
            "POST",
            "/oauth/token",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const params = yield* request.urlParamsBody.pipe(
                Effect.orElseSucceed(() => UrlParams.make([])),
              );
              if (formField(params, "subject_token") !== PAIR) {
                return HttpServerResponse.text("Unauthorized", { status: 401 });
              }
              if (formField(params, "grant_type") !== AuthTokenExchangeGrantType) {
                return HttpServerResponse.text("Unauthorized", { status: 401 });
              }
              return HttpServerResponse.text(
                encodeAccessToken({
                  access_token: "access-models",
                  issued_token_type: AuthAccessTokenType,
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: AuthOrchestrationReadScope,
                }),
                { contentType: "application/json" },
              );
            }),
          ),
          HttpRouter.add(
            "POST",
            "/api/auth/websocket-ticket",
            Effect.succeed(
              HttpServerResponse.text(
                encodeWebSocketTicket({
                  ticket: "ticket-models",
                  expiresAt: DateTime.toUtc(NOW),
                }),
                { contentType: "application/json" },
              ),
            ),
          ),
          HttpRouter.add(
            "GET",
            "/ws",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const requestUrl = HttpServerRequest.toURL(request);
              const protocol = Option.isSome(requestUrl)
                ? requestUrl.value.searchParams.get("orchestrationProtocol")
                : null;
              if (protocol !== ORCHESTRATION_PROTOCOL_VERSION_TEXT) {
                return HttpServerResponse.text("Upgrade Required", { status: 426 });
              }
              const upgraded = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
              yield* RpcServer.make(T3ConfigRpc).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(RpcServer.Protocol, upgraded.protocol),
                    T3ConfigRpc.toLayer({
                      [WS_METHODS.serverGetConfig]: () => Effect.succeed(CONFIG),
                    }),
                    Layer.succeed(RpcScopeAuthorization, (effect) => effect),
                    RpcSerialization.layerJson,
                  ),
                ),
                Effect.forkScoped,
              );
              return yield* upgraded.httpEffect;
            }).pipe(Effect.provide(RpcSerialization.layerJson)),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(RpcSerialization.layerJson),
      ),
    ),
  ),
);
