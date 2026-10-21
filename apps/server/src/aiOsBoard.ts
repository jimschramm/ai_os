import { ADAPTER_BOARD_EVENTS_PATH, ADAPTER_BOARD_PATH } from "@t3tools/ai-os-adapter/board";
import { makeAdapterBoardHub } from "@t3tools/ai-os-adapter/board-hub";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  Effect.sync(() => {
    const hub = makeAdapterBoardHub();
    const snapshot = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      return HttpServerResponse.text(hub.snapshot(), { contentType: "application/json" });
    }).pipe(Effect.catchTags(authResponse));
    const replace = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      if (!hub.replace(text)) {
        return HttpServerResponse.text("Invalid board.", { status: 400 });
      }
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(Effect.catchTags(authResponse));
    const events = Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      return yield* hub.events;
    }).pipe(Effect.catchTags(authResponse));
    return Layer.mergeAll(
      HttpRouter.add("GET", ADAPTER_BOARD_PATH, snapshot),
      HttpRouter.add("POST", ADAPTER_BOARD_PATH, replace),
      HttpRouter.add("GET", ADAPTER_BOARD_EVENTS_PATH, events),
    );
  }),
);
