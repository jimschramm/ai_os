// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_PATH,
  decodeAdapterBoard,
  encodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AiOsBoard from "./aiOsBoard.ts";
import * as ServerConfig from "./config.ts";

const disposers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const handlerFor = (stateDir?: string) => {
  const dir = stateDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aios-board-"));
  if (!dirs.includes(dir)) dirs.push(dir);
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
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          stateDir: dir,
        } as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, stateDir: dir };
};

const idleCard = (taskId: string, title: string): AdapterBoardCard => ({
  taskId,
  title,
  state: { phase: "idle" },
  threadId: null,
  updatedAt: "2026-10-21T18:00:00Z",
});

const boardUrl = (path: string) => `http://t3.test${path}`;

describe("ai-os board route", () => {
  it("requires a read session to snapshot and an operate session to replace it", async () => {
    const { handler } = handlerFor();
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

  it("upserts each task and reloads the snapshot after a restart", async () => {
    const first = handlerFor();
    const post = (handler: typeof first.handler, card: AdapterBoardCard) =>
      handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          method: "POST",
          headers: {
            authorization: `Bearer ${AuthOrchestrationOperateScope}`,
            "content-type": "application/json",
          },
          body: encodeAdapterBoard([card]),
        }),
      );
    const read = (handler: typeof first.handler) =>
      handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
        }),
      );

    expect((await post(first.handler, idleCard("task-a", "First"))).status).toBe(204);
    expect((await post(first.handler, idleCard("task-b", "Second"))).status).toBe(204);
    const kept = decodeAdapterBoard(await (await read(first.handler)).text());
    expect(kept?.map((card) => card.taskId)).toEqual(["task-a", "task-b"]);

    const second = handlerFor(first.stateDir);
    const reloaded = decodeAdapterBoard(await (await read(second.handler)).text());
    expect(reloaded?.map((card) => [card.taskId, card.title])).toEqual([
      ["task-a", "First"],
      ["task-b", "Second"],
    ]);

    expect((await post(second.handler, idleCard("task-a", "Updated"))).status).toBe(204);
    const updated = decodeAdapterBoard(await (await read(second.handler)).text());
    expect(updated?.map((card) => [card.taskId, card.title])).toEqual([
      ["task-a", "Updated"],
      ["task-b", "Second"],
    ]);
  });

  it("rejects an empty id, a blank title, and a non-Z timestamp", async () => {
    const { handler } = handlerFor();
    const post = (body: string) =>
      handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          method: "POST",
          headers: {
            authorization: `Bearer ${AuthOrchestrationOperateScope}`,
            "content-type": "application/json",
          },
          body,
        }),
      );
    const valid = encodeAdapterBoard([idleCard("task-a", "First")]);
    expect((await post(valid)).status).toBe(204);
    for (const body of [
      encodeAdapterBoard([{ ...idleCard("task-a", "First"), taskId: "" }]),
      encodeAdapterBoard([{ ...idleCard("task-a", "First"), title: " " }]),
      encodeAdapterBoard([
        { ...idleCard("task-a", "First"), updatedAt: "2026-10-21T18:00:00+00:00" },
      ]),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    const kept = decodeAdapterBoard(
      await (
        await handler(
          new Request(boardUrl(ADAPTER_BOARD_PATH), {
            headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
          }),
        )
      ).text(),
    );
    expect(kept?.map((card) => card.title)).toEqual(["First"]);
  });

  it("keeps every card when publishes run together", async () => {
    const { handler } = handlerFor();
    const ids = Array.from({ length: 12 }, (_, index) => `task-${index}`);
    const statuses = await Promise.all(
      ids.map((id) =>
        handler(
          new Request(boardUrl(ADAPTER_BOARD_PATH), {
            method: "POST",
            headers: {
              authorization: `Bearer ${AuthOrchestrationOperateScope}`,
              "content-type": "application/json",
            },
            body: encodeAdapterBoard([idleCard(id, `Title ${id}`)]),
          }),
        ).then((response) => response.status),
      ),
    );
    expect(statuses).toEqual(ids.map(() => 204));
    const reader = await handler(
      new Request(boardUrl(ADAPTER_BOARD_PATH), {
        headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
      }),
    );
    const cards = decodeAdapterBoard(await reader.text());
    expect(cards?.map((card) => card.taskId).sort()).toEqual([...ids].sort());
  });

  it("returns 500 when the snapshot cannot be written", async () => {
    const { handler, stateDir } = handlerFor();
    NodeFS.chmodSync(stateDir, 0o555);
    try {
      const denied = await handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          method: "POST",
          headers: {
            authorization: `Bearer ${AuthOrchestrationOperateScope}`,
            "content-type": "application/json",
          },
          body: encodeAdapterBoard([idleCard("task-a", "First")]),
        }),
      );
      expect(denied.status).toBe(500);
    } finally {
      NodeFS.chmodSync(stateDir, 0o755);
    }
    const reader = await handler(
      new Request(boardUrl(ADAPTER_BOARD_PATH), {
        headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
      }),
    );
    expect(decodeAdapterBoard(await reader.text())).toEqual([]);
  });
});
