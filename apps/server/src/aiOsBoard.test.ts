import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_PATH,
  encodeAdapterBoard,
} from "@t3tools/ai-os-adapter/board";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AiOsBoard from "./aiOsBoard.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const handlerFor = () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    AiOsBoard.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
            const header = request.headers.authorization;
            if (header === `Bearer ${AuthOrchestrationOperateScope}`) {
              return Effect.succeed({
                scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              });
            }
            if (header === `Bearer ${AuthOrchestrationReadScope}`) {
              return Effect.succeed({ scopes: [AuthOrchestrationReadScope] });
            }
            return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
          },
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

const boardUrl = (path: string) => `http://t3.test${path}`;

describe("ai-os board route", () => {
  it("requires a read session to snapshot and an operate session to replace it", async () => {
    const handler = handlerFor();
    const missing = await handler(new Request(boardUrl(ADAPTER_BOARD_PATH)));
    expect(missing.status).toBe(401);

    const reader = await handler(
      new Request(boardUrl(ADAPTER_BOARD_PATH), {
        headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
      }),
    );
    expect(reader.status).toBe(200);
    expect(await reader.text()).toBe(encodeAdapterBoard([]));

    const denied = await handler(
      new Request(boardUrl(ADAPTER_BOARD_PATH), {
        method: "POST",
        headers: {
          authorization: `Bearer ${AuthOrchestrationReadScope}`,
          "content-type": "application/json",
        },
        body: "nope",
      }),
    );
    expect(denied.status).toBe(403);

    const invalid = await handler(
      new Request(boardUrl(ADAPTER_BOARD_PATH), {
        method: "POST",
        headers: {
          authorization: `Bearer ${AuthOrchestrationOperateScope}`,
          "content-type": "application/json",
        },
        body: "nope",
      }),
    );
    expect(invalid.status).toBe(400);

    const replaced = await handler(
      new Request(boardUrl(ADAPTER_BOARD_PATH), {
        method: "POST",
        headers: {
          authorization: `Bearer ${AuthOrchestrationOperateScope}`,
          "content-type": "application/json",
        },
        body: encodeAdapterBoard([]),
      }),
    );
    expect(replaced.status).toBe(204);

    const events = await handler(
      new Request(boardUrl(ADAPTER_BOARD_EVENTS_PATH), {
        headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
      }),
    );
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const body = events.body?.getReader();
    if (body === undefined) throw new Error("missing board stream");
    const first = await body.read();
    await body.cancel();
    expect(new TextDecoder().decode(first.value)).toContain("data:");
  });
});
