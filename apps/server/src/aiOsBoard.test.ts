// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ADAPTER_ANTIGRAVITY_MODELS_PATH,
  ADAPTER_BOARD_EVENT_PATH,
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_MOVE_PATH,
  ADAPTER_BOARD_PATH,
  decodeAdapterBoard,
  encodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import { encodeAdapterBoardWire } from "@t3tools/ai-os-adapter/board-hub";
import {
  applySequence,
  assignmentExample,
  exampleRepoCommit,
  executionLaunchKey,
  happyPathEvents,
  intakeV2Example,
  leaseIdFor,
} from "@t3tools/ai-os-contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AiOsAntigravity from "./aiOsAntigravity.ts";
import * as AiOsBoard from "./aiOsBoard.ts";
import * as ServerConfig from "./config.ts";

const activeLaunch = (): AiOsBoard.BoardLaunchResult => ({
  threadId: "thread-1",
  runId: "run-1",
  disposition: "active",
  summary: null,
});

const idleReviews: AiOsAntigravity.AntigravityReviews["Service"] = {
  listModels: () => Effect.succeed({ source: "unverified", models: [], detail: null }),
  start: () => Effect.die("Antigravity review was not expected."),
  watch: () => Effect.succeed(null),
  cancel: () => Effect.succeed("already_stopped"),
  recover: () => Effect.succeed({ status: "stopped" as const }),
  sweep: () => Effect.void,
};

const allowRuns: AiOsBoard.BoardRuns["Service"] = {
  interrupt: () => Effect.succeed("requested"),
  confirmLaunch: () => Effect.succeed("active"),
  launch: () => Effect.succeed(activeLaunch()),
  continueRun: () => Effect.succeed({ runId: "run-continued" }),
  watchThread: () => Effect.succeed(null),
  followRuns: false,
};

const disposers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const handlerFor = (
  stateDir?: string,
  runs: AiOsBoard.BoardRuns["Service"] = allowRuns,
  reviews: AiOsAntigravity.AntigravityReviews["Service"] = idleReviews,
) => {
  const dir = stateDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aios-board-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const { handler, dispose } = HttpRouter.toWebHandler(
    AiOsBoard.layer.pipe(
      Layer.provide(Layer.succeed(AiOsBoard.BoardRuns, runs)),
      Layer.provide(Layer.succeed(AiOsAntigravity.AntigravityReviews, reviews)),
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

const idleCard = (taskId: string, title: string, revision = 1): AdapterBoardCard => ({
  taskId,
  title,
  state: { phase: "idle" },
  threadId: null,
  runId: null,
  revision,
  updatedAt: "2026-10-21T18:00:00Z",
});

const preparedDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aios-board-"));
  dirs.push(dir);
  return dir;
};

const seedIdle = (
  dir: string,
  cards: ReadonlyArray<{ taskId: string; title: string; revision?: number }>,
) => {
  NodeFS.writeFileSync(
    NodePath.join(dir, "ai-os-board.json"),
    encodeAdapterBoardWire(
      cards.map((card) => ({
        taskId: card.taskId,
        title: card.title,
        state: { phase: "idle" as const },
        threadId: null,
        runId: null,
        revision: card.revision ?? 1,
        updatedAt: "2026-10-21T18:00:00Z",
      })),
    ),
  );
};

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

  it("updates metadata and reloads the snapshot after a restart", async () => {
    const dir = preparedDir();
    seedIdle(dir, [
      { taskId: "task-a", title: "First" },
      { taskId: "task-b", title: "Second" },
    ]);
    const first = handlerFor(dir);
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

    const created = await post(first.handler, idleCard("task-c", "Third", 0));
    expect(created.status).toBe(409);
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
          ...idleCard("task-a", "Updated", revision),
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
    const dir = preparedDir();
    seedIdle(dir, [{ taskId: "task-a", title: "First" }]);
    const { handler } = handlerFor(dir);
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
    const valid = encodeAdapterBoard([idleCard("task-a", "First", 1)]);
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
    const ids = Array.from({ length: 12 }, (_, index) => `task-${index}`);
    const dir = preparedDir();
    seedIdle(
      dir,
      ids.map((id) => ({ taskId: id, title: `Title ${id}` })),
    );
    const { handler } = handlerFor(dir);
    const statuses = await Promise.all(
      ids.map((id) =>
        handler(
          new Request(boardUrl(ADAPTER_BOARD_PATH), {
            method: "POST",
            headers: {
              authorization: `Bearer ${AuthOrchestrationOperateScope}`,
              "content-type": "application/json",
            },
            body: encodeAdapterBoard([idleCard(id, `Renamed ${id}`, 1)]),
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
    expect(cards?.every((card) => card.title.startsWith("Renamed "))).toBe(true);
  });

  it("returns 500 when the snapshot cannot be written", async () => {
    const dir = preparedDir();
    seedIdle(dir, [{ taskId: "task-a", title: "First" }]);
    const { handler, stateDir } = handlerFor(dir);
    NodeFS.chmodSync(stateDir, 0o555);
    try {
      const denied = await handler(
        new Request(boardUrl(ADAPTER_BOARD_PATH), {
          method: "POST",
          headers: {
            authorization: `Bearer ${AuthOrchestrationOperateScope}`,
            "content-type": "application/json",
          },
          body: encodeAdapterBoard([idleCard("task-a", "Updated", 1)]),
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
    expect(decodeAdapterBoard(await reader.text())?.map((card) => card.title)).toEqual(["First"]);
  });

  it("moves a card only through the workflow and refuses a second run or a silent cancel", async () => {
    const interrupts: string[] = [];
    const launches: string[] = [];
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      interrupt: (input) => {
        interrupts.push(input.runId);
        return Effect.succeed("requested");
      },
      confirmLaunch: () => Effect.succeed("active"),
      launch: (input) => {
        launches.push(input.idempotencyKey);
        return Effect.succeed(activeLaunch());
      },
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
    expect(fromBoard.status).toBe(200);
    expect(await fromBoard.json()).toMatchObject({ _tag: "Applied", changed: true });
    expect(launches).toEqual([executionLaunchKey("task-demo", "attempt-1", 1)]);
    expect(await phaseOf()).toBe("executing");
    const runningCard = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(runningCard?.threadId).toBe("thread-1");
    expect(runningCard?.runId).toBe("run-1");

    const secondDrop = await move("Running", "start-2");
    expect(secondDrop.status).toBe(200);
    expect(await secondDrop.json()).toMatchObject({ _tag: "Applied", changed: false });
    expect(launches).toEqual([executionLaunchKey("task-demo", "attempt-1", 1)]);
    expect(await phaseOf()).toBe("executing");

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
      ...allowRuns,
      interrupt: () =>
        Effect.fail(
          new AiOsBoard.BoardRunError({ detail: "The run did not confirm the interrupt." }),
        ),
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
      ...allowRuns,
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
      const dir = preparedDir();
      seedIdle(dir, [{ taskId: "task-a", title: "First" }]);
      const { handler } = handlerFor(dir);
      const created = yield* Effect.promise(() =>
        postJson(handler, ADAPTER_BOARD_PATH, [idleCard("task-new", "Created", 0)]),
      );
      expect(created.status).toBe(409);
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

  it("records a finished launch as review instead of leaving it Ready", async () => {
    let launches = 0;
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      confirmLaunch: () => Effect.succeed("settled"),
      launch: () => {
        launches += 1;
        return Effect.succeed({
          threadId: "thread-fast",
          runId: "run-fast",
          disposition: "completed",
          summary: "Done already.",
        });
      },
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "fast-1",
    });
    expect(moved.status).toBe(200);
    expect(launches).toBe(1);
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
    const again = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "fast-2",
    });
    expect(again.status).toBe(409);
    expect(launches).toBe(1);
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
  });

  it("records a failed launch as blocked instead of leaving it Ready", async () => {
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      confirmLaunch: () => Effect.succeed("settled"),
      launch: () =>
        Effect.succeed({
          threadId: "thread-fail",
          runId: "run-fail",
          disposition: "failed",
          summary: "The provider exited.",
        }),
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "fail-fast",
    });
    expect(moved.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("failed");
  });

  it("accepts start for a run that already finished, then the completion", async () => {
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      confirmLaunch: () => Effect.succeed("settled"),
    });
    await reachAssigned(handler);
    const started = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "start-settled",
      threadId: "thread-1",
      runId: "run-1",
      event: { type: "start_execution" },
    });
    expect(started.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("executing");
    const done = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "complete-settled",
      threadId: "thread-1",
      runId: "run-1",
      event: {
        type: "submit_completion",
        completion: {
          version: "v1",
          taskId: "task-demo",
          attemptId: "attempt-1",
          generation: 1,
          leaseId: leaseIdFor(1),
          claimedOutcome: "Finished before the board caught up.",
          artifactRevision: { type: "named", kind: "page", id: "t3-result" },
          evidence: [{ kind: "readback", ref: "thread:thread-1" }],
        },
      },
    });
    expect(done.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
  });

  it("leaves the card Ready when the launch is refused", async () => {
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      launch: () => Effect.fail(new AiOsBoard.BoardRunError({ detail: "The provider is down." })),
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "launch-down",
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({
      detail: expect.stringMatching(/provider is down/),
    });
    expect(await phaseOfHandler(handler)).toBe("assigned");
  });

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

  it("launches with the assignment's provider instance", async () => {
    const launched: Array<{ instanceId: string; model: string }> = [];
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      launch: (input) => {
        launched.push({ instanceId: input.instanceId, model: input.model });
        return Effect.succeed(activeLaunch());
      },
    });
    await reachAssigned(handler);
    const assigned = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-grok",
      title: "Grok task",
      idempotencyKey: "intake-grok",
      event: {
        type: "intake",
        intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
      },
    });
    expect(assigned.status).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-grok",
          column: "Ready",
          idempotencyKey: "ready-grok",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-grok",
          title: "Grok task",
          idempotencyKey: "assign-grok",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-grok",
              attemptId: "attempt-grok",
              assignmentId: "assignment-grok",
              instanceId: "grok",
            },
          },
        })
      ).status,
    ).toBe(200);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-grok",
      column: "Running",
      idempotencyKey: "run-grok",
    });
    expect(moved.status).toBe(200);
    expect(launched).toEqual([{ instanceId: "grok", model: "gpt-5.4" }]);
  });

  it("reviews with Antigravity and leaves Codex unlaunched", async () => {
    const launched: string[] = [];
    let reviewed = 0;
    const { handler } = handlerFor(
      undefined,
      {
        ...allowRuns,
        launch: () => {
          launched.push("codex");
          return Effect.succeed(activeLaunch());
        },
      },
      {
        ...idleReviews,
        start: () => {
          reviewed += 1;
          return Effect.succeed({
            status: "settled" as const,
            runId: "agy-run-1",
            execution: {
              status: "completed",
              requestedModel: "gemini-4-argon-high",
              actualModel: "gemini-4-argon-high",
              unverified: false,
              commit: exampleRepoCommit,
              summary: "The schedule page is missing Sunday.",
              findings: [
                {
                  commit: exampleRepoCommit,
                  files: ["src/page.tsx"],
                  evidence: "The page lists Saturday only.",
                  suggestedAction: "Add Sunday to the schedule.",
                },
              ],
              progressNote: "Read src/page.tsx.",
              conversationId: "conv1",
              inputTokens: 12,
              outputTokens: 4,
              sourcePath: "/tmp/source",
              scratchPath: "/tmp/scratch",
              detail: null,
            },
          });
        },
      },
    );
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "intake-agy",
          event: {
            type: "intake",
            intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Ready",
          idempotencyKey: "ready-agy",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "assign-agy",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-agy",
              attemptId: "attempt-agy",
              assignmentId: "assignment-agy",
              instanceId: "antigravity",
              role: "advisory",
              taskType: "advisory",
            },
          },
        })
      ).status,
    ).toBe(200);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy",
      model: "gemini-4-argon-high",
    });
    expect(moved.status).toBe(200);
    const card = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(card?.state.phase).toBe("review_delivered");
    expect(card?.threadId).toBeNull();
    if (card?.state.phase !== "review_delivered") return;
    expect(card.state.reviewLabel).toBe("Review delivered");
    expect("qa" in card.state).toBe(false);
    expect(card.state.run.advisory?.findings).toHaveLength(1);
    expect(card.state.run.advisory?.model.unverified).toBe(false);
    const requested = card.state.run.advisory?.model.requested;
    const actual = card.state.run.advisory?.model.actual;
    expect(typeof requested === "string" ? requested : requested?.model).toBe(
      "gemini-4-argon-high",
    );
    expect(typeof actual === "string" ? actual : actual?.model).toBe("gemini-4-argon-high");
    expect(launched).toEqual([]);
    expect(reviewed).toBe(1);
  });

  it("keeps the card Ready when the Antigravity model is unavailable", async () => {
    const { handler } = handlerFor(undefined, allowRuns, {
      ...idleReviews,
      start: () =>
        Effect.succeed({
          status: "unavailable" as const,
          detail:
            "gemini-missing is not available from the CLI. Choose one of: gemini-4-argon-high",
          models: ["gemini-4-argon-high"],
        }),
    });
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "intake-agy",
          event: {
            type: "intake",
            intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Ready",
          idempotencyKey: "ready-agy",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "assign-agy",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-agy",
              attemptId: "attempt-agy",
              assignmentId: "assignment-agy",
              instanceId: "antigravity",
              role: "advisory",
              taskType: "advisory",
            },
          },
        })
      ).status,
    ).toBe(200);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy",
      model: "gemini-missing",
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({
      _tag: "Rejected",
      detail: expect.stringContaining("gemini-missing"),
    });
    const card = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(card?.state.phase).toBe("assigned");
  });

  it("does not launch Codex for a non-advisory Antigravity assignment", async () => {
    const launched: string[] = [];
    let reviewed = 0;
    const { handler } = handlerFor(
      undefined,
      {
        ...allowRuns,
        launch: () => {
          launched.push("codex");
          return Effect.succeed(activeLaunch());
        },
      },
      {
        ...idleReviews,
        start: () => {
          reviewed += 1;
          return Effect.die("review");
        },
      },
    );
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Implement",
          idempotencyKey: "intake-agy",
          event: {
            type: "intake",
            intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Ready",
          idempotencyKey: "ready-agy",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Implement",
          idempotencyKey: "assign-agy",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-agy",
              attemptId: "attempt-agy",
              assignmentId: "assignment-agy",
              instanceId: "antigravity",
              role: "implementer",
              taskType: "implementation",
            },
          },
        })
      ).status,
    ).toBe(200);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy",
    });
    expect(moved.status).toBe(409);
    expect(launched).toEqual([]);
    expect(reviewed).toBe(0);
    const card = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(card?.state.phase).toBe("assigned");
  });

  it("returns the Antigravity model catalog", async () => {
    const { handler } = handlerFor();
    const response = await handler(
      new Request(boardUrl(ADAPTER_ANTIGRAVITY_MODELS_PATH), {
        headers: { authorization: `Bearer ${AuthOrchestrationReadScope}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "unverified", models: [], detail: null });
  });

  it("launches rework as the next generation and does not launch that generation twice", async () => {
    const launches: string[] = [];
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      launch: (input) => {
        launches.push(input.idempotencyKey);
        return Effect.succeed({
          threadId: "thread-2",
          runId: "run-2",
          disposition: "active",
          summary: null,
        });
      },
    });
    for (const [index, event] of happyPathEvents.slice(0, 9).entries()) {
      const posted = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
        taskId: "task-usba-page",
        title: "Tournament page",
        idempotencyKey: `path-${index}`,
        threadId: "thread-rework",
        runId: "run-rework",
        event,
      });
      expect(posted.status).toBe(200);
    }
    const phase = async () =>
      (await readCards(handler)).find((card) => card.taskId === "task-usba-page")?.state.phase;
    expect(await phase()).toBe("rework");
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-usba-page",
      column: "Running",
      idempotencyKey: "rework-run",
    });
    expect(moved.status).toBe(200);
    expect(launches).toEqual([executionLaunchKey("task-usba-page", "attempt-1", 2)]);
    expect(await phase()).toBe("executing");
    const again = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-usba-page",
      column: "Running",
      idempotencyKey: "rework-run-2",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ changed: false });
    expect(launches).toEqual([executionLaunchKey("task-usba-page", "attempt-1", 2)]);
  });

  it("records failure from the thread view after an active launch", async () => {
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      watchThread: () =>
        Effect.succeed({
          threadId: "thread-1",
          runId: "run-1",
          status: "failed",
          text: "codex exited",
          revision: null,
        }),
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "watch-fail",
    });
    expect(moved.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("failed");
    const card = (await readCards(handler)).find((item) => item.taskId === "task-demo");
    expect(card?.state.phase === "failed" ? card.state.blocker.summary : "").toBe("codex exited");
  });

  it("records working progress from a still-running thread", async () => {
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      watchThread: () =>
        Effect.succeed({
          threadId: "thread-1",
          runId: "run-1",
          status: "running",
          text: "draft",
          revision: null,
        }),
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "watch-run",
    });
    expect(moved.status).toBe(200);
    const card = (await readCards(handler)).find((item) => item.taskId === "task-demo");
    expect(card?.state.phase).toBe("executing");
    expect(card?.state.phase === "executing" ? card.state.run.progress?.status : null).toBe(
      "working",
    );
  });

  it("resumes a blocked card on the same thread and does not continue twice", async () => {
    const continued: string[] = [];
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      continueRun: (input) => {
        continued.push(input.commandId);
        return Effect.succeed({ runId: "run-2" });
      },
    });
    await reachExecuting(handler);
    const paused = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Blocked",
      idempotencyKey: "pause-1",
      confirmed: true,
    });
    expect(paused.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("recovery_pending");
    const resumed = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "resume-drop",
    });
    expect(resumed.status).toBe(200);
    expect(continued).toEqual(["continue-task-demo-2"]);
    expect(await phaseOfHandler(handler)).toBe("executing");
    const card = (await readCards(handler)).find((item) => item.taskId === "task-demo");
    expect(card?.runId).toBe("run-2");
    expect(card?.state.phase === "executing" ? card.state.run.generation : 0).toBe(2);
    const again = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "resume-drop-2",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ changed: false });
    expect(continued).toEqual(["continue-task-demo-2"]);
  });

  it("cancels a running advisory review through the board", async () => {
    let canceled = 0;
    const { handler } = handlerFor(undefined, allowRuns, {
      ...idleReviews,
      start: () => Effect.succeed({ status: "running" as const, runId: "agy-run-1" }),
      cancel: () => {
        canceled += 1;
        return Effect.succeed("requested" as const);
      },
    });
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "intake-agy",
          event: {
            type: "intake",
            intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Ready",
          idempotencyKey: "ready-agy",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "assign-agy",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-agy",
              attemptId: "attempt-agy",
              assignmentId: "assignment-agy",
              instanceId: "antigravity",
              taskType: "advisory",
            },
          },
        })
      ).status,
    ).toBe(200);
    const running = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy",
      model: "gemini-4-argon-high",
    });
    expect(running.status).toBe(200);
    const card = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(card?.state.phase).toBe("executing");
    const stopped = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Ready",
      idempotencyKey: "cancel-agy",
      confirmed: true,
    });
    expect(stopped.status).toBe(200);
    expect(canceled).toBe(1);
    const after = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(after?.state.phase).toBe("assigned");
  });

  it("keeps an interrupted advisory review blocked until the old process stops", async () => {
    let starts = 0;
    let processRunning = true;
    let worktree = true;
    let stopSignals = 0;
    let swept = 0;
    const reviews = {
      ...idleReviews,
      sweep: () => {
        swept += 1;
        return Effect.void;
      },
      start: () => {
        starts += 1;
        return Effect.succeed({ status: "running" as const, runId: `agy-run-${starts}` });
      },
      watch: () => Effect.succeed(null),
      recover: () => {
        if (processRunning) {
          stopSignals += 1;
          return Effect.succeed({ status: "still_running" as const });
        }
        worktree = false;
        return Effect.succeed({ status: "stopped" as const });
      },
    };
    const first = handlerFor(undefined, allowRuns, reviews);
    expect(
      (
        await postJson(first.handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "intake-agy",
          event: {
            type: "intake",
            intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(first.handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Ready",
          idempotencyKey: "ready-agy",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(first.handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-agy",
          title: "Advisory review",
          idempotencyKey: "assign-agy",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-agy",
              attemptId: "attempt-agy",
              assignmentId: "assignment-agy",
              taskType: "advisory",
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(first.handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Running",
          idempotencyKey: "run-agy",
          model: "gemini-4-argon-high",
        })
      ).status,
    ).toBe(200);
    const running = (await readCards(first.handler)).find((item) => item.taskId === "task-agy");
    expect(running?.state.phase).toBe("executing");
    expect(starts).toBe(1);
    const second = handlerFor(first.stateDir, allowRuns, reviews);
    const recovered = (await readCards(second.handler)).find((item) => item.taskId === "task-agy");
    expect(recovered?.state.phase).toBe("recovery_pending");
    expect(recovered?.threadId).toBeNull();
    expect(swept).toBe(1);
    expect(stopSignals).toBe(0);
    expect(worktree).toBe(true);
    const blocked = await postJson(second.handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy-blocked",
      model: "gemini-4-argon-high",
    });
    expect(blocked.status).toBe(409);
    expect(stopSignals).toBe(1);
    expect(worktree).toBe(true);
    expect(starts).toBe(1);
    const stillBlocked = (await readCards(second.handler)).find(
      (item) => item.taskId === "task-agy",
    );
    expect(stillBlocked?.state.phase).toBe("recovery_pending");
    processRunning = false;
    const again = await postJson(second.handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy-again",
      model: "gemini-4-argon-high",
    });
    expect(again.status).toBe(200);
    expect(starts).toBe(2);
    expect(worktree).toBe(false);
    const restarted = (await readCards(second.handler)).find((item) => item.taskId === "task-agy");
    expect(restarted?.state.phase).toBe("executing");
    expect(restarted?.state.phase === "executing" ? restarted.state.assignment.attemptId : "").toBe(
      "retry-task-agy-2",
    );
    const late = await postJson(second.handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-agy",
      idempotencyKey: "late-agy",
      event: {
        type: "report_progress",
        report: {
          version: "v1",
          taskId: "task-agy",
          attemptId: "attempt-agy",
          generation: restarted?.state.phase === "executing" ? restarted.state.run.generation : 1,
          leaseId: restarted?.state.phase === "executing" ? restarted.state.run.leaseId : "lease-1",
          status: "working",
          blockers: [],
          partialArtifacts: [],
        },
      },
    });
    expect(late.status).toBe(409);
    const after = (await readCards(second.handler)).find((item) => item.taskId === "task-agy");
    expect(after?.state.phase).toBe("executing");
    expect(after?.state.phase === "executing" ? after.state.assignment.attemptId : "").toBe(
      "retry-task-agy-2",
    );
    expect(after?.state.phase === "executing" ? after.state.run.progress : "touched").toBeNull();
  });
});
