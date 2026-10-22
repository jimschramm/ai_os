// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_MOVE_PATH,
  ADAPTER_BOARD_PATH,
  decodeAdapterBoard,
  encodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import {
  applySequence,
  assignmentExample,
  happyPathEvents,
  intakeV2Example,
  leaseIdFor,
} from "@t3tools/ai-os-contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AiOsBoard from "./aiOsBoard.ts";
import * as ServerConfig from "./config.ts";

const allowRuns: AiOsBoard.BoardRuns["Service"] = {
  interrupt: () => Effect.succeed("requested"),
  confirmLaunch: () => Effect.void,
};

const disposers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const handlerFor = (stateDir?: string, runs: AiOsBoard.BoardRuns["Service"] = allowRuns) => {
  const dir = stateDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aios-board-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const { handler, dispose } = HttpRouter.toWebHandler(
    AiOsBoard.layer.pipe(
      Layer.provide(Layer.succeed(AiOsBoard.BoardRuns, runs)),
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

const postJson = (handler: (request: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(
    new Request(boardUrl(path), {
      method: "POST",
      headers: {
        authorization: `Bearer ${AuthOrchestrationOperateScope}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

const readCards = async (handler: (request: Request) => Promise<Response>) => {
  const reader = await handler(
    new Request(boardUrl(ADAPTER_BOARD_PATH), {
      headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
    }),
  );
  return decodeAdapterBoard(await reader.text()) ?? [];
};

const phaseOfHandler = async (handler: (request: Request) => Promise<Response>) =>
  (await readCards(handler)).find((card) => card.taskId === "task-demo")?.state.phase;

const usageCount = (cards: readonly AdapterBoardCard[]) => {
  const card = cards.find((item) => item.taskId === "task-demo");
  if (card?.state.phase !== "executing") return -1;
  return card.state.run.usage.length;
};

const reachAssigned = async (handler: (request: Request) => Promise<Response>) => {
  const intake = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
    taskId: "task-demo",
    title: "Demo task",
    idempotencyKey: "intake-1",
    event: {
      type: "intake",
      intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
    },
  });
  if (intake.status !== 200) throw new Error(`intake ${intake.status}`);
  const ready = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
    taskId: "task-demo",
    column: "Ready",
    idempotencyKey: "ready-1",
  });
  if (ready.status !== 200) throw new Error(`ready ${ready.status}`);
  const assigned = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
    taskId: "task-demo",
    title: "Demo task",
    idempotencyKey: "assign-1",
    event: {
      type: "assign",
      assignment: {
        ...assignmentExample,
        taskId: "task-demo",
        attemptId: "attempt-1",
        assignmentId: "assignment-1",
      },
    },
  });
  if (assigned.status !== 200) throw new Error(`assign ${assigned.status}`);
};

const reachExecuting = async (handler: (request: Request) => Promise<Response>) => {
  await reachAssigned(handler);
  const started = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
    taskId: "task-demo",
    title: "Demo task",
    idempotencyKey: "start-1",
    threadId: "thread-1",
    runId: "run-1",
    event: { type: "start_execution" },
  });
  if (started.status !== 200) throw new Error(`start ${started.status}`);
};

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
    expect(replaced.status).toBe(200);

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

    expect((await post(first.handler, idleCard("task-a", "First"))).status).toBe(200);
    expect((await post(first.handler, idleCard("task-b", "Second"))).status).toBe(200);
    const kept = decodeAdapterBoard(await (await read(first.handler)).text());
    expect(kept?.map((card) => card.taskId)).toEqual(["task-a", "task-b"]);

    const second = handlerFor(first.stateDir);
    const reloaded = decodeAdapterBoard(await (await read(second.handler)).text());
    expect(reloaded?.map((card) => [card.taskId, card.title])).toEqual([
      ["task-a", "First"],
      ["task-b", "Second"],
    ]);

    const current = decodeAdapterBoard(await (await read(second.handler)).text());
    const revision = current?.find((card) => card.taskId === "task-a")?.revision ?? 0;
    expect(
      (
        await post(second.handler, {
          ...idleCard("task-a", "Updated"),
          revision,
        })
      ).status,
    ).toBe(200);
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
    expect((await post(valid)).status).toBe(200);
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
    expect(statuses).toEqual(ids.map(() => 200));
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

  it("moves a card only through the workflow and refuses a second run or a silent cancel", async () => {
    const interrupts: string[] = [];
    const { handler } = handlerFor(undefined, {
      interrupt: (input) => {
        interrupts.push(input.runId);
        return Effect.succeed("requested");
      },
      confirmLaunch: () => Effect.void,
    });
    const operate = (path: string, body: unknown) =>
      handler(
        new Request(boardUrl(path), {
          method: "POST",
          headers: {
            authorization: `Bearer ${AuthOrchestrationOperateScope}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const phaseOf = async () => {
      const reader = await handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
        }),
      );
      const cards = decodeAdapterBoard(await reader.text());
      const card = cards?.find((item) => item.taskId === "task-demo");
      if (card === undefined) throw new Error("missing task-demo");
      return card.state.phase;
    };
    const generationOf = async () => {
      const reader = await handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
        }),
      );
      const cards = decodeAdapterBoard(await reader.text());
      const card = cards?.find((item) => item.taskId === "task-demo");
      if (card?.state.phase !== "executing" && card?.state.phase !== "assigned") {
        throw new Error(`expected a run, got ${card?.state.phase}`);
      }
      return card.state.phase === "executing"
        ? card.state.run.generation
        : (card.state.heldRun?.generation ?? null);
    };
    const event = (
      idempotencyKey: string,
      workflow: unknown,
      extra: Record<string, unknown> = {},
    ) =>
      operate(ADAPTER_BOARD_EVENT_PATH, {
        taskId: "task-demo",
        title: "Demo task",
        idempotencyKey,
        event: workflow,
        ...extra,
      });
    const move = (column: string, idempotencyKey: string, confirmed = false) =>
      operate(ADAPTER_BOARD_MOVE_PATH, {
        taskId: "task-demo",
        column,
        idempotencyKey,
        confirmed,
      });

    expect(
      (
        await event("intake-1", {
          type: "intake",
          intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
        })
      ).status,
    ).toBe(200);
    expect(await phaseOf()).toBe("requested");

    const skipped = await move("Done", "done-1");
    expect(skipped.status).toBe(409);
    expect(await skipped.json()).toMatchObject({
      _tag: "Rejected",
      detail: expect.stringMatching(/different model/),
    });
    expect(await phaseOf()).toBe("requested");

    expect((await move("Ready", "ready-1")).status).toBe(200);
    expect(await phaseOf()).toBe("acknowledged");

    expect(
      (
        await event("assign-1", {
          type: "assign",
          assignment: {
            ...assignmentExample,
            taskId: "task-demo",
            attemptId: "attempt-1",
            assignmentId: "assignment-1",
          },
        })
      ).status,
    ).toBe(200);
    expect(await phaseOf()).toBe("assigned");

    const fromBoard = await move("Running", "start-1");
    expect(fromBoard.status).toBe(409);
    expect(await fromBoard.json()).toMatchObject({
      _tag: "Rejected",
      detail: expect.stringMatching(/adapter launches the run/),
    });
    expect(await phaseOf()).toBe("assigned");

    const missingRun = await event("start-missing", { type: "start_execution" });
    expect(missingRun.status).toBe(409);
    expect(await phaseOf()).toBe("assigned");

    const started = await event(
      "start-1",
      { type: "start_execution" },
      { threadId: "thread-1", runId: "run-1" },
    );
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ _tag: "Applied", changed: true });
    expect(await phaseOf()).toBe("executing");
    expect(await generationOf()).toBe(1);

    const repeatedStart = await event(
      "start-again",
      { type: "start_execution" },
      { threadId: "thread-1", runId: "run-1" },
    );
    expect(repeatedStart.status).toBe(200);
    expect(await repeatedStart.json()).toMatchObject({ _tag: "Applied", changed: false });
    expect(await generationOf()).toBe(1);

    const silent = await move("Ready", "cancel-1");
    expect(silent.status).toBe(409);
    expect(await silent.json()).toMatchObject({ _tag: "NeedsConfirmation" });
    expect(await phaseOf()).toBe("executing");
    expect(interrupts).toEqual([]);

    const confirmed = await move("Ready", "cancel-1", true);
    expect(confirmed.status).toBe(200);
    expect(interrupts).toEqual(["run-1"]);
    expect(await phaseOf()).toBe("assigned");
    expect(await generationOf()).toBe(1);
  });

  it("leaves the card executing when the interrupt is not confirmed", async () => {
    const { handler } = handlerFor(undefined, {
      interrupt: () =>
        Effect.fail(
          new AiOsBoard.BoardRunError({ detail: "The run did not confirm the interrupt." }),
        ),
      confirmLaunch: () => Effect.void,
    });
    await reachExecuting(handler);
    const cancelled = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Ready",
      idempotencyKey: "cancel-fail",
      confirmed: true,
    });
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({
      detail: expect.stringMatching(/did not confirm the interrupt/),
    });
    expect(await phaseOfHandler(handler)).toBe("executing");
  });

  it("does not mark In Progress when the launch is not active", async () => {
    const { handler } = handlerFor(undefined, {
      interrupt: () => Effect.succeed("requested"),
      confirmLaunch: () =>
        Effect.fail(
          new AiOsBoard.BoardRunError({
            detail: "That run is not active, so the board will not mark it in progress.",
          }),
        ),
    });
    await reachAssigned(handler);
    const started = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "start-dead",
      threadId: "thread-1",
      runId: "run-missing",
      event: { type: "start_execution" },
    });
    expect(started.status).toBe(409);
    expect(await phaseOfHandler(handler)).toBe("assigned");
  });

  effectIt.effect("rejects a stale snapshot and a snapshot that would accept the card", () =>
    Effect.gen(function* () {
      const { handler } = handlerFor();
      const created = yield* Effect.promise(() =>
        postJson(handler, ADAPTER_BOARD_PATH, [idleCard("task-a", "First")]),
      );
      expect(created.status).toBe(200);
      const stale = yield* Effect.promise(() =>
        postJson(handler, ADAPTER_BOARD_PATH, [{ ...idleCard("task-a", "Renamed"), revision: 0 }]),
      );
      expect(stale.status).toBe(409);
      expect(yield* Effect.promise(() => stale.json())).toMatchObject({
        detail: expect.stringMatching(/server kept its copy/),
      });
      const cards = yield* Effect.promise(() => readCards(handler));
      expect(cards.find((card) => card.taskId === "task-a")?.title).toBe("First");

      const accepted = yield* applySequence(happyPathEvents);
      const bypass = yield* Effect.promise(() =>
        postJson(handler, ADAPTER_BOARD_PATH, [
          {
            taskId: "task-done",
            title: "Accepted by snapshot",
            state: accepted,
            threadId: null,
            runId: null,
            revision: 0,
            updatedAt: "2026-10-21T18:00:00Z",
          },
        ]),
      );
      expect(bypass.status).toBe(409);
      expect(yield* Effect.promise(() => bypass.json())).toMatchObject({
        detail: expect.stringMatching(/workflow/),
      });
      expect((yield* Effect.promise(() => readCards(handler))).map((card) => card.taskId)).toEqual([
        "task-a",
      ]);
    }),
  );

  it("does not append usage again when the same event is replayed after a restart", async () => {
    const first = handlerFor();
    await reachExecuting(first.handler);
    const usage = {
      type: "report_usage",
      generation: 1,
      leaseId: leaseIdFor(1),
      measurement: {
        kind: "reported_tokens",
        inputTokens: 4,
        outputTokens: 2,
        attribution: {
          projectId: "usba",
          taskId: "task-demo",
          attemptId: "attempt-1",
          agentId: "codex-t3",
          platform: "t3",
          provider: "openai",
          model: { model: "gpt-5.4" },
        },
      },
    };
    const posted = await postJson(first.handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "usage-1",
      event: usage,
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ _tag: "Applied", changed: true });
    expect(usageCount(await readCards(first.handler))).toBe(1);
    const raw = NodeFS.readFileSync(NodePath.join(first.stateDir, "ai-os-board.json"), "utf8");
    expect(raw).toContain("usage-1");
    expect(raw.trim().startsWith("{")).toBe(true);

    const second = handlerFor(first.stateDir);
    const replay = await postJson(second.handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "usage-1",
      event: usage,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ _tag: "Applied", changed: false });
    expect(usageCount(await readCards(second.handler))).toBe(1);
  });
});
