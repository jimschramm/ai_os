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
  ADAPTER_MEMORY_COMMIT_PATH,
  ADAPTER_MEMORY_RESOLVE_PATH,
  ADAPTER_MEMORY_SUPPLY_PATH,
  ADAPTER_MEMORY_WRITE_PATH,
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
import { openMemoryDatabase, submitMemorySync } from "./aiOsMemory.ts";
import {
  readAttemptActivitySync,
  recordTaskWriteSync,
  supplyTaskMemorySync,
} from "./aiOsTaskMemory.ts";
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
  readReviewerSession: () => Effect.succeed(null),
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

  effectIt.effect("keeps in-flight cards from a board saved before rework ledgers", () =>
    Effect.gen(function* () {
      const executing = yield* applySequence(happyPathEvents.slice(0, 4));
      const awaiting = yield* applySequence(happyPathEvents.slice(0, 6));
      const withoutLedger = (state: object) => {
        const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
        delete copy.reworkLedger;
        return copy;
      };
      const dir = preparedDir();
      NodeFS.writeFileSync(
        NodePath.join(dir, "ai-os-board.json"),
        JSON.stringify({
          cards: [
            {
              taskId: "task-usba-page",
              title: "Schedule still running",
              state: withoutLedger(executing),
              threadId: "thread:usba",
              runId: "run:usba",
              revision: 4,
              updatedAt: "2026-10-21T18:00:00Z",
            },
            {
              taskId: "task-usba-qa",
              title: "Schedule waiting on QA",
              state: withoutLedger(awaiting),
              threadId: null,
              revision: 5,
              updatedAt: "2026-10-21T18:05:00Z",
            },
          ],
          ledger: {},
        }),
      );
      const { handler } = handlerFor(dir);
      const loaded = yield* Effect.promise(() => readCards(handler));
      expect(loaded.map((card) => [card.taskId, card.title, card.state.phase])).toEqual([
        ["task-usba-page", "Schedule still running", "executing"],
        ["task-usba-qa", "Schedule waiting on QA", "awaiting_qa"],
      ]);
    }),
  );

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
      watchThread: () =>
        Effect.succeed({
          threadId: "thread-fast",
          runId: "run-fast",
          status: "completed",
          text: "Done already.",
          revision: null,
          requestedModel: "gpt-5.4",
          actualModel: "gpt-6-sol",
        }),
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
    const reviewed = (await readCards(handler)).find((item) => item.taskId === "task-demo");
    expect(
      reviewed?.state.phase === "awaiting_qa" ? reviewed.state.run.implementerRuntime : null,
    ).toEqual({
      requested: "gpt-5.4",
      actual: "gpt-6-sol",
    });
    const again = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "fast-2",
    });
    expect(again.status).toBe(409);
    expect(launches).toBe(1);
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
  });

  it("shows a blocker when a finished launch has no implementer model", async () => {
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      confirmLaunch: () => Effect.succeed("settled"),
      launch: () =>
        Effect.succeed({
          threadId: "thread-unknown",
          runId: "run-unknown",
          disposition: "completed",
          summary: "Done already.",
        }),
      watchThread: () =>
        Effect.succeed({
          threadId: "thread-unknown",
          runId: "run-unknown",
          status: "completed",
          text: "Done already.",
          revision: null,
          requestedModel: null,
          actualModel: null,
        }),
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "unknown-model",
    });
    expect(moved.status).toBe(200);
    const card = (await readCards(handler)).find((item) => item.taskId === "task-demo");
    expect(card?.state.phase).toBe("executing");
    expect(card?.state.phase === "executing" ? card.state.run.implementerRuntime : "recorded").toBe(
      undefined,
    );
    expect(card?.state.phase === "executing" ? card.state.run.progress?.status : null).toBe(
      "blocked",
    );
    expect(
      card?.state.phase === "executing" ? card.state.run.progress?.blockers[0]?.summary : null,
    ).toBe("Awaiting implementer model");
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
    const recorded = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "runtime-settled",
      event: {
        type: "record_runtime_models",
        taskId: "task-demo",
        attemptId: "attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        role: "implementer",
        requested: { model: "gpt-5.4" },
        actual: { model: "gpt-5.4" },
      },
    });
    expect(recorded.status).toBe(200);
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

  const modelName = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (
      value !== null &&
      typeof value === "object" &&
      "model" in value &&
      typeof value.model === "string"
    ) {
      return value.model;
    }
    return null;
  };

  const REVIEWER = "claude-sonnet-5";

  const sessionRuns = (
    reviewer: { readonly requested: string | null; readonly actual: string | null } | null,
  ): { readonly runs: AiOsBoard.BoardRuns["Service"]; readonly models: string[] } => {
    const models: string[] = [];
    let impl = 0;
    const runs: AiOsBoard.BoardRuns["Service"] = {
      ...allowRuns,
      launch: (input) => {
        models.push(input.model);
        impl += 1;
        return Effect.succeed({
          threadId: `thread-impl-${impl}`,
          runId: `run-impl-${impl}`,
          disposition: "active",
          summary: null,
        });
      },
      watchThread: (threadId) => {
        const revision = threadId.endsWith("-2") ? "b".repeat(40) : "a".repeat(40);
        return Effect.succeed({
          threadId,
          runId: threadId.replace("thread", "run"),
          status: "completed" as const,
          text: "Shipped the page.",
          revision,
          requestedModel: "gpt-5.4",
          actualModel: "gpt-5.4",
        });
      },
      readReviewerSession: () =>
        Effect.succeed(
          reviewer === null
            ? null
            : {
                threadId: "thread-qa",
                runId: "run-qa",
                status: "completed" as const,
                text: null,
                revision: null,
                requestedModel: reviewer.requested,
                actualModel: reviewer.actual,
              },
        ),
    };
    return { runs, models };
  };

  const finding = {
    defect: "The schedule omits the final round.",
    evidence: "The preview still lists Saturday only.",
    expectedBehavior: "The page lists Saturday and Sunday.",
  };

  const verdictFor = (
    revision:
      | { readonly type: "git"; readonly sha: string }
      | { readonly type: "named"; readonly kind: "page"; readonly id: string },
    verdict: "rework" | "accept",
    qaModel: string,
  ) => ({
    version: "v1" as const,
    taskId: "task-demo",
    attemptId: "attempt-1",
    availability: "available" as const,
    qaModel,
    implementerModel: "gpt-5.4",
    verdict,
    artifactRevision: revision,
    ...(verdict === "accept" ? { acceptedRevision: revision } : {}),
    findings: [finding],
  });

  const qaEvent = (
    revision:
      | { readonly type: "git"; readonly sha: string }
      | { readonly type: "named"; readonly kind: "page"; readonly id: string },
    verdict: "rework" | "accept",
    qaModel: string,
  ) => ({
    type: "qa" as const,
    threadId: "thread-qa",
    runId: "run-qa",
    qa: verdictFor(revision, verdict, qaModel),
  });

  it("records the submitting session, then reworks and accepts on a different model", async () => {
    const { runs, models } = sessionRuns({ requested: REVIEWER, actual: REVIEWER });
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-run",
    });
    expect(moved.status).toBe(200);
    const waiting = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(waiting?.state.phase).toBe("awaiting_qa");
    if (waiting?.state.phase !== "awaiting_qa") throw new Error("expected review");
    expect(waiting.state.run.reviewerRuntime).toBeUndefined();
    expect(modelName(waiting.state.run.implementerRuntime?.actual)).toBe("gpt-5.4");
    const first = waiting.state.completion.artifactRevision;
    if (first.type !== "git") throw new Error("expected the provider revision");
    const reworked = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-rework",
      event: qaEvent(first, "rework", REVIEWER),
    });
    expect(reworked.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("rework");
    const again = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-run-2",
    });
    expect(again.status).toBe(200);
    const second = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(second?.state.phase).toBe("awaiting_qa");
    if (second?.state.phase !== "awaiting_qa") throw new Error("expected the second review");
    const revision = second.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the corrected revision");
    expect(revision.sha).not.toBe(first.sha);
    const accepted = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-accept-2",
      event: qaEvent(revision, "accept", REVIEWER),
    });
    expect(accepted.status).toBe(200);
    const done = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(done?.state.phase).toBe("accepted");
    if (done?.state.phase !== "accepted") throw new Error("expected acceptance");
    expect(modelName(done.state.run.reviewerRuntime?.actual)).toBe(REVIEWER);
    expect(modelName(done.state.run.implementerRuntime?.actual)).toBe("gpt-5.4");
    expect(models).toEqual(["gpt-5.4", "gpt-5.4"]);
  });

  it("keeps findings and waits when the submitting session has no actual model", async () => {
    const { runs, models } = sessionRuns({ requested: REVIEWER, actual: null });
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-unknown",
    });
    const waiting = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    if (waiting?.state.phase !== "awaiting_qa") throw new Error("expected review");
    const revision = waiting.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the provider revision");
    const reworked = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-unknown-rework",
      event: qaEvent(revision, "rework", REVIEWER),
    });
    expect(reworked.status).toBe(200);
    const held = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(held?.state.phase).toBe("qa_incomplete");
    if (held?.state.phase !== "qa_incomplete") throw new Error("expected incomplete QA");
    expect(held.state.qaLabel).toBe("Awaiting a verified reviewer");
    expect(held.state.attemptedVerdict).toBe("rework");
    expect(held.state.findings).toEqual([finding]);
    expect(held.state.run.reviewerRuntime).toBeUndefined();
    const accepted = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-unknown-accept",
      event: qaEvent(revision, "accept", REVIEWER),
    });
    expect(accepted.status).toBe(200);
    const still = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(still?.state.phase).toBe("qa_incomplete");
    if (still?.state.phase !== "qa_incomplete") throw new Error("expected incomplete QA");
    expect(still.state.attemptedVerdict).toBe("accept");
    expect(still.state.findings).toEqual([finding]);
    expect(models).toEqual(["gpt-5.4"]);
  });

  it("blocks completion when the implementer's actual model is unknown", async () => {
    const { handler } = handlerFor();
    await reachExecuting(handler);
    const blocked = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "complete-unknown-implementer",
      event: {
        type: "submit_completion",
        completion: {
          version: "v1",
          taskId: "task-demo",
          attemptId: "attempt-1",
          generation: 1,
          leaseId: leaseIdFor(1),
          claimedOutcome: "Finished without a reported model.",
          artifactRevision: { type: "named", kind: "page", id: "t3-result" },
          evidence: [{ kind: "readback", ref: "thread:thread-1" }],
        },
      },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      detail: expect.stringMatching(/actual model is unknown/),
    });
    expect(await phaseOfHandler(handler)).toBe("executing");
  });

  it("rejects a reviewer thread that is the implementer's thread", async () => {
    const { runs } = sessionRuns({ requested: REVIEWER, actual: REVIEWER });
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-own-thread",
    });
    const waiting = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    if (waiting?.state.phase !== "awaiting_qa" || waiting.threadId === null) {
      throw new Error("expected the implementer's thread");
    }
    const revision = waiting.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the provider revision");
    const rejected = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-own-thread",
      event: { ...qaEvent(revision, "accept", REVIEWER), threadId: waiting.threadId },
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      detail: expect.stringMatching(/implementer's thread/),
    });
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
  });

  it("rejects a reviewer thread that belongs to another task", async () => {
    const { runs } = sessionRuns({ requested: REVIEWER, actual: REVIEWER });
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-this-task",
    });
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-other",
          title: "Other task",
          idempotencyKey: "intake-other",
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
          taskId: "task-other",
          column: "Ready",
          idempotencyKey: "ready-other",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-other",
          title: "Other task",
          idempotencyKey: "assign-other",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-other",
              attemptId: "attempt-other",
              assignmentId: "assignment-other",
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-other",
          column: "Running",
          idempotencyKey: "run-other",
        })
      ).status,
    ).toBe(200);
    const cards = await readCards(handler);
    const demo = cards.find((card) => card.taskId === "task-demo");
    const other = cards.find((card) => card.taskId === "task-other");
    if (demo?.state.phase !== "awaiting_qa" || other === undefined || other.threadId === null) {
      throw new Error("expected the other task's thread");
    }
    const revision = demo.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the provider revision");
    const rejected = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-other-task",
      event: { ...qaEvent(revision, "accept", REVIEWER), threadId: other.threadId },
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      detail: expect.stringMatching(/not from this task/),
    });
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
  });

  it("lets a verified reviewer replace an unknown one and accept", async () => {
    const reviewer = { requested: REVIEWER, actual: null as string | null };
    const { runs } = sessionRuns(reviewer);
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-replace",
    });
    const waiting = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    if (waiting?.state.phase !== "awaiting_qa") throw new Error("expected review");
    const revision = waiting.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the provider revision");
    const held = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-held",
      event: qaEvent(revision, "accept", REVIEWER),
    });
    expect(held.status).toBe(200);
    expect(await phaseOfHandler(handler)).toBe("qa_incomplete");
    reviewer.actual = REVIEWER;
    const accepted = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-verified",
      event: qaEvent(revision, "accept", REVIEWER),
    });
    expect(accepted.status).toBe(200);
    const done = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(done?.state.phase).toBe("accepted");
    if (done?.state.phase !== "accepted") throw new Error("expected acceptance");
    expect(modelName(done.state.run.reviewerRuntime?.actual)).toBe(REVIEWER);
    expect(done.state.run.priorReviews?.[0]?.attemptedVerdict).toBe("accept");
    expect(done.state.run.priorReviews?.[0]?.findings).toEqual([finding]);
  });

  it("rejects a verdict whose models differ from the submitting session", async () => {
    const { runs } = sessionRuns({ requested: REVIEWER, actual: REVIEWER });
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-mismatch",
    });
    const waiting = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    if (waiting?.state.phase !== "awaiting_qa") throw new Error("expected review");
    const revision = waiting.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the provider revision");
    const rejected = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-payload-mismatch",
      event: qaEvent(revision, "rework", "gpt-6-sol"),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      detail: expect.stringMatching(/reviewer/),
    });
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
  });

  it("rejects rework when the submitting session ran the implementer's model", async () => {
    const { runs } = sessionRuns({ requested: "gpt-5.4", actual: "gpt-5.4" });
    const { handler } = handlerFor(undefined, runs);
    await reachAssigned(handler);
    await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "impl-same",
    });
    const waiting = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    if (waiting?.state.phase !== "awaiting_qa") throw new Error("expected review");
    const revision = waiting.state.completion.artifactRevision;
    if (revision.type !== "git") throw new Error("expected the provider revision");
    const rejected = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "qa-same-base",
      event: qaEvent(revision, "rework", REVIEWER),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      detail: expect.stringMatching(/different base model/),
    });
    expect(await phaseOfHandler(handler)).toBe("awaiting_qa");
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
    let starts = 0;
    let processRunning = true;
    let worktree = true;
    const { handler } = handlerFor(undefined, allowRuns, {
      ...idleReviews,
      start: () => {
        starts += 1;
        return Effect.succeed({ status: "running" as const, runId: `agy-run-${starts}` });
      },
      cancel: () => {
        canceled += 1;
        return Effect.succeed("requested" as const);
      },
      recover: () => {
        if (processRunning) return Effect.succeed({ status: "still_running" as const });
        worktree = false;
        return Effect.succeed({ status: "stopped" as const });
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
    expect(after?.state.phase).toBe("recovery_pending");
    const early = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy-early",
      model: "gemini-4-argon-high",
    });
    expect(early.status).toBe(409);
    expect(starts).toBe(1);
    expect(worktree).toBe(true);
    const held = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(held?.state.phase).toBe("recovery_pending");
    processRunning = false;
    const again = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-agy",
      column: "Running",
      idempotencyKey: "run-agy-again",
      model: "gemini-4-argon-high",
    });
    expect(again.status).toBe(200);
    expect(starts).toBe(2);
    expect(worktree).toBe(false);
    const restarted = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(restarted?.state.phase).toBe("executing");
    expect(restarted?.state.phase === "executing" ? restarted.state.assignment.attemptId : "").toBe(
      "retry-task-agy-2",
    );
  });

  it("keeps an advisory cancel event blocked until the process stops", async () => {
    let canceled = 0;
    let starts = 0;
    let processRunning = true;
    let worktree = true;
    const { handler } = handlerFor(undefined, allowRuns, {
      ...idleReviews,
      start: () => {
        starts += 1;
        return Effect.succeed({ status: "running" as const, runId: `agy-run-${starts}` });
      },
      cancel: () => {
        canceled += 1;
        return Effect.succeed("requested" as const);
      },
      recover: () => {
        if (processRunning) return Effect.succeed({ status: "still_running" as const });
        worktree = false;
        return Effect.succeed({ status: "stopped" as const });
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
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-agy",
          column: "Running",
          idempotencyKey: "run-agy",
          model: "gemini-4-argon-high",
        })
      ).status,
    ).toBe(200);
    const canceledEvent = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-agy",
      title: "Advisory review",
      idempotencyKey: "cancel-event-agy",
      event: {
        type: "cancel",
        command: {
          command: "cancel",
          idempotencyKey: "cancel-event-agy-c",
          taskId: "task-agy",
          attemptId: "attempt-agy",
        },
      },
    });
    expect(canceledEvent.status).toBe(200);
    expect(canceled).toBe(1);
    const after = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(after?.state.phase).toBe("recovery_pending");
    const early = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-agy",
      title: "Advisory review",
      idempotencyKey: "continue-agy-early",
      event: {
        type: "continue",
        command: {
          command: "continue",
          idempotencyKey: "continue-agy-early-c",
          taskId: "task-agy",
          attemptId: "attempt-agy",
        },
      },
    });
    expect(early.status).toBe(409);
    expect(starts).toBe(1);
    expect(worktree).toBe(true);
    const held = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(held?.state.phase).toBe("recovery_pending");
    expect(held?.state.phase === "recovery_pending" ? held.state.assignment.attemptId : "").toBe(
      "attempt-agy",
    );
    processRunning = false;
    const again = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-agy",
      title: "Advisory review",
      idempotencyKey: "continue-agy",
      model: "gemini-4-argon-high",
      event: {
        type: "continue",
        command: {
          command: "continue",
          idempotencyKey: "continue-agy-c",
          taskId: "task-agy",
          attemptId: "attempt-agy",
        },
      },
    });
    expect(again.status).toBe(200);
    expect(starts).toBe(2);
    expect(worktree).toBe(false);
    const restarted = (await readCards(handler)).find((item) => item.taskId === "task-agy");
    expect(restarted?.state.phase).toBe("executing");
    expect(restarted?.state.phase === "executing" ? restarted.state.assignment.attemptId : "").toBe(
      "retry-task-agy-2",
    );
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

  it("sends the memory package in the launch and skips a receipt the launch left out", async () => {
    const decision = "Saturday games start at 7:00.";
    const prompts: string[] = [];
    const orientations: string[][] = [];
    const { handler, stateDir } = handlerFor(
      undefined,
      {
        ...allowRuns,
        launch: (input) => {
          prompts.push(input.prompt);
          const id = prompts.length;
          return Effect.succeed({
            threadId: `thread-${id}`,
            runId: `run-${id}`,
            disposition: "active" as const,
            summary: null,
          });
        },
      },
      {
        ...idleReviews,
        start: (input) => {
          orientations.push([...(input.orientation ?? [])]);
          return Effect.succeed({ status: "running" as const, runId: "agy-run-memory" });
        },
      },
    );
    const database = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    submitMemorySync(
      database,
      {
        version: "v1",
        submissionId: "submission-start",
        idempotencyKey: "key-start",
        projectId: "usba",
        authorId: "jim",
        taskId: "task-seed",
        attemptId: "attempt-seed",
        evidence: [{ evidenceId: "evidence-start", note: "The schedule file says so." }],
        expectedVersions: [],
        intent: "accept",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-start",
              projectId: "usba",
              kind: "Decision",
              body: decision,
              provenance: { actorId: "jim", at: "2026-10-24T06:00:00Z" },
              validity: { from: "2026-10-24T06:00:00Z", until: null },
            },
          },
        ],
        relationships: [],
      },
      "jim",
    );
    database.close();

    await reachAssigned(handler);
    const bare = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "start-without-package",
      threadId: "thread-bare",
      runId: "run-bare",
      event: { type: "start_execution" },
    });
    expect(bare.status).toBe(200);
    expect(prompts).toEqual([]);
    const skipped = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    expect(readAttemptActivitySync(skipped).some((item) => item.attemptId === "attempt-1")).toBe(
      false,
    );
    skipped.close();

    const assign = async (
      taskId: string,
      attemptId: string,
      instanceId: string,
      extra: Record<string, string> = {},
    ) => {
      expect(
        (
          await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
            taskId,
            title: taskId,
            idempotencyKey: `intake-${taskId}`,
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
            taskId,
            column: "Ready",
            idempotencyKey: `ready-${taskId}`,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
            taskId,
            title: taskId,
            idempotencyKey: `assign-${taskId}`,
            event: {
              type: "assign",
              assignment: {
                ...assignmentExample,
                taskId,
                attemptId,
                assignmentId: `assignment-${taskId}`,
                instanceId,
                ...extra,
              },
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
            taskId,
            column: "Running",
            idempotencyKey: `run-${taskId}`,
          })
        ).status,
      ).toBe(200);
    };

    await assign("task-codex", "attempt-codex", "codex");
    await assign("task-cursor", "attempt-cursor", "cursor");
    await assign("task-agy-memory", "attempt-agy-memory", "antigravity", {
      role: "advisory",
      taskType: "advisory",
    });

    expect(prompts).toHaveLength(2);
    expect(
      prompts.every((prompt) => prompt.includes(decision) && prompt.includes("Orientation")),
    ).toBe(true);
    expect(orientations.map((lines) => lines[0])).toEqual([decision]);
    expect(
      orientations.every((lines) => lines.some((line) => line.includes(ADAPTER_MEMORY_WRITE_PATH))),
    ).toBe(true);
    expect(prompts.every((prompt) => prompt.includes(ADAPTER_MEMORY_WRITE_PATH))).toBe(true);

    const saved = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    const activity = readAttemptActivitySync(saved);
    saved.close();
    expect(activity.map((item) => item.attemptId).sort()).toEqual([
      "attempt-agy-memory",
      "attempt-codex",
      "attempt-cursor",
    ]);
    expect(activity.find((item) => item.attemptId === "attempt-cursor")).toMatchObject({
      authorId: "t3-codex",
      runtime: "cursor",
    });
    expect(activity.find((item) => item.attemptId === "attempt-codex")?.runtime).toBe("codex");
    expect(activity.find((item) => item.attemptId === "attempt-agy-memory")?.runtime).toBe(
      "antigravity",
    );

    const cards = await readCards(handler);
    const cursor = cards.find((card) => card.taskId === "task-cursor");
    expect(cursor?.attempts?.map((item) => item.attemptId)).toEqual(["attempt-cursor"]);
    expect(cursor?.attempts?.[0]?.authorId).toBe("t3-codex");
  });

  it("does not save a read receipt when the launch is rejected before the prompt is sent", async () => {
    const prompts: string[] = [];
    const { handler, stateDir } = handlerFor(undefined, {
      ...allowRuns,
      launch: (input) => {
        prompts.push(input.prompt);
        return Effect.fail(
          new AiOsBoard.BoardRunError({ detail: "HTTP 409 sentToProvider:false" }),
        );
      },
    });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "launch-rejected",
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({
      detail: expect.stringMatching(/sentToProvider:false/),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(assignmentExample.contextPackage.requirements);
    expect(prompts[0]).toContain(assignmentExample.contextPackage.repoCommit);
    expect(await phaseOfHandler(handler)).toBe("assigned");
    const saved = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    expect(readAttemptActivitySync(saved).some((item) => item.attemptId === "attempt-1")).toBe(
      false,
    );
    saved.close();
  });

  it("flags a conflicting write, records the correction, and the next run reads it", async () => {
    const prompts: string[] = [];
    const { handler, stateDir } = handlerFor(undefined, {
      ...allowRuns,
      launch: (input) => {
        prompts.push(input.prompt);
        return Effect.succeed(activeLaunch());
      },
    });
    const at = "2026-10-24T06:00:00Z";
    const database = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    const request = (attemptId: string, authorId: string, taskId: string) => ({
      projectId: "usba",
      taskId,
      attemptId,
      authorId,
      runtime: "codex" as const,
      repoCommit: exampleRepoCommit,
      requirements: "The tournament page shows the new schedule.",
      authorizationScope: "usba-web",
      createdAt: at,
    });
    const finding = (authorId: string, factId: string, body: string) => ({
      kind: "findings" as const,
      facts: [
        {
          identity: "tournament-start",
          fact: {
            acceptance: "proposed" as const,
            factId,
            projectId: "usba",
            kind: "Decision" as const,
            body,
            provenance: { actorId: authorId, at },
            validity: { from: at, until: null },
          },
        },
      ],
      relationships: [],
      evidence: [{ evidenceId: `evidence-${factId}`, note: `${authorId} read the schedule.` }],
    });
    supplyTaskMemorySync(database, request("attempt-a", "agent-a", "task-a"));
    expect(
      recordTaskWriteSync(
        database,
        "attempt-a",
        finding("agent-a", "fact-agent-a", "Saturday games start at 7:00."),
        "jim",
      ).outcome,
    ).toBe("pending");
    expect(
      submitMemorySync(
        database,
        {
          version: "v1",
          submissionId: "submission-accept",
          idempotencyKey: "key-accept",
          projectId: "usba",
          authorId: "jim",
          taskId: "task-a",
          attemptId: "attempt-accept",
          evidence: [{ evidenceId: "evidence-accept", note: "Jim accepted the schedule." }],
          expectedVersions: [],
          intent: "accept",
          facts: [
            {
              identity: "tournament-start",
              fact: {
                acceptance: "proposed",
                factId: "fact-accepted",
                projectId: "usba",
                kind: "Decision",
                body: "Saturday games start at 7:00.",
                provenance: { actorId: "jim", at },
                validity: { from: at, until: null },
              },
            },
          ],
          relationships: [],
        },
        "jim",
      ).outcome,
    ).toBe("accepted");
    supplyTaskMemorySync(database, request("attempt-b", "agent-b", "task-demo"));
    expect(
      recordTaskWriteSync(
        database,
        "attempt-b",
        finding("agent-b", "fact-agent-b", "Saturday games start at 8:30."),
        "jim",
      ).outcome,
    ).toBe("conflict");
    database.close();

    await reachAssigned(handler);
    const before = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    const notice = before?.steward?.find((item) => item.kind === "open_conflict");
    if (notice?.conflictId == null) throw new Error("expected an open steward conflict");
    expect(notice.authorId).toBe("agent-b");
    expect(notice.summary).toContain("conflicts with accepted memory");
    expect(
      before?.attempts?.some(
        (item) => item.attemptId === "attempt-b" && item.write?.outcome === "conflict",
      ),
    ).toBe(true);
    expect(
      before?.memoryFacts?.some(
        (fact) => fact.body === "Saturday games start at 7:00." && fact.acceptance === "accepted",
      ),
    ).toBe(true);
    expect(
      before?.memoryFacts?.some(
        (fact) =>
          fact.body === "Saturday games start at 8:30." && fact.provenance.actorId === "agent-b",
      ),
    ).toBe(true);

    const resolved = await postJson(handler, ADAPTER_MEMORY_RESOLVE_PATH, {
      conflictId: notice.conflictId,
      action: "correct",
      body: "Saturday games start at 7:30.",
    });
    expect(resolved.status).toBe(200);
    const applied = (await resolved.json()) as { readonly factIds: readonly string[] };
    expect(applied.factIds.length).toBeGreaterThan(0);

    const after = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(after?.steward?.find((item) => item.kind === "open_conflict")).toBeUndefined();
    expect(
      after?.memoryFacts?.some(
        (fact) => fact.body === "Saturday games start at 7:30." && fact.acceptance === "accepted",
      ),
    ).toBe(true);
    expect(after?.memoryFacts?.find((fact) => fact.provenance.actorId === "agent-b")).toMatchObject(
      {
        acceptance: "superseded",
      },
    );

    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "launch-corrected",
    });
    expect(moved.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Saturday games start at 7:30.");
    expect(prompts[0]).not.toContain("Saturday games start at 8:30.");
    expect(prompts[0]).not.toContain("Saturday games start at 7:00.");

    const saved = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    const launch = readAttemptActivitySync(saved).find((item) => item.attemptId === "attempt-1");
    saved.close();
    expect(launch?.read.receiptId).toBe("read-attempt-1");
    expect(launch?.read.memoryVersions).toEqual(expect.arrayContaining([...applied.factIds]));
  });

  it("keeps an attempt's fact proposed until Jim resolves the next attempt's conflict", async () => {
    const prompts: string[] = [];
    let launches = 0;
    const { handler } = handlerFor(undefined, {
      ...allowRuns,
      launch: (input) => {
        prompts.push(input.prompt);
        launches += 1;
        return Effect.succeed({
          threadId: `thread-${launches}`,
          runId: `run-${launches}`,
          disposition: "active" as const,
          summary: null,
        });
      },
    });
    const fact = "Saturday games start at 7:00.";
    const conflict = "Saturday games start at 8:30.";
    const resolution = "Saturday games start at 7:30.";
    const finished = "Finished without replacing the schedule fact.";
    const at = "2026-10-24T06:00:00Z";
    const tokenIn = (prompt: string | undefined): string => {
      const found = prompt?.match(/Memory write token: (wt-[0-9a-f]{32})/);
      if (found?.[1] === undefined) throw new Error("The launch prompt has no write token.");
      return found[1];
    };
    const factWrite = (attemptId: string, writeToken: string, body: string, evidenceId: string) =>
      postJson(handler, ADAPTER_MEMORY_WRITE_PATH, {
        attemptId,
        writeToken,
        write: {
          kind: "fact",
          identity: "tournament-start",
          nodeKind: "Decision",
          body,
          evidence: [{ evidenceId, note: "The schedule file says so." }],
        },
      });
    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "launch-write",
    });
    expect(moved.status).toBe(200);
    expect(prompts[0]).toContain(ADAPTER_MEMORY_WRITE_PATH);
    expect(prompts[0]).toContain("attempt-1");
    expect(prompts[0]).toContain("project usba");
    const tokenA = tokenIn(prompts[0]);

    const other = await factWrite("attempt-other", tokenA, fact, "evidence-other");
    expect(other.status).toBe(409);

    const foreign = await postJson(handler, ADAPTER_MEMORY_WRITE_PATH, {
      attemptId: "attempt-1",
      writeToken: tokenA,
      write: {
        kind: "findings",
        facts: [
          {
            identity: "other-project",
            fact: {
              acceptance: "proposed",
              factId: "fact-other",
              projectId: "other",
              kind: "Decision",
              body: "This belongs somewhere else.",
              provenance: { actorId: "t3-codex", at },
              validity: { from: at, until: null },
            },
          },
        ],
        relationships: [],
        evidence: [{ evidenceId: "evidence-other-project", note: "Wrong project." }],
      },
    });
    expect(foreign.status).toBe(409);

    const written = await factWrite("attempt-1", tokenA, fact, "evidence-start");
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ _tag: "Applied", outcome: "pending" });

    const proposedFact = (await readCards(handler))
      .find((card) => card.taskId === "task-demo")
      ?.memoryFacts?.find((item) => item.body === fact);
    expect(proposedFact).toMatchObject({
      acceptance: "proposed",
      factId: "fact-attempt-1-tournament-start",
      provenance: { actorId: "t3-codex" },
    });
    expect(
      (await readCards(handler))
        .find((card) => card.taskId === "task-demo")
        ?.memoryFacts?.some(
          (item) => item.acceptance === "accepted" || item.provenance.actorId === "jim",
        ),
    ).toBe(false);

    const again = await factWrite("attempt-1", tokenA, conflict, "evidence-again");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: "duplicate" });

    const assign = async () => {
      expect(
        (
          await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
            taskId: "task-next",
            title: "Next task",
            idempotencyKey: "intake-next",
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
            taskId: "task-next",
            column: "Ready",
            idempotencyKey: "ready-next",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
            taskId: "task-next",
            title: "Next task",
            idempotencyKey: "assign-next",
            event: {
              type: "assign",
              assignment: {
                ...assignmentExample,
                taskId: "task-next",
                attemptId: "attempt-2",
                assignmentId: "assignment-next",
                workerId: "agent-b",
              },
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
            taskId: "task-next",
            column: "Running",
            idempotencyKey: "run-next",
          })
        ).status,
      ).toBe(200);
    };
    await assign();
    expect(prompts[1]).toContain(`proposed, not accepted: ${fact}`);
    expect(prompts[1]).toContain(ADAPTER_MEMORY_WRITE_PATH);
    expect(prompts[1]).toContain("attempt-2");
    expect(prompts[1]).not.toContain(conflict);
    const tokenB = tokenIn(prompts[1]);

    const next = (await readCards(handler)).find((card) => card.taskId === "task-next");
    const read = next?.attempts?.find((item) => item.attemptId === "attempt-2");
    expect(read?.read.memoryVersions).toContain(proposedFact?.factId);
    expect(
      next?.memoryFacts?.some((item) => item.body === fact && item.acceptance === "accepted"),
    ).toBe(false);

    const crossed = await factWrite("attempt-2", tokenA, conflict, "evidence-cross");
    expect(crossed.status).toBe(409);
    const crossedBack = await factWrite("attempt-1", tokenB, conflict, "evidence-cross-back");
    expect(crossedBack.status).toBe(409);

    const proposed = await factWrite("attempt-2", tokenB, conflict, "evidence-b");
    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ _tag: "Applied", outcome: "conflict" });

    const visibleCards = await readCards(handler);
    const visible = visibleCards.find((card) => card.taskId === "task-next");
    const openConflictNotices = visibleCards
      .flatMap((card) => card.steward ?? [])
      .filter((item) => item.kind === "open_conflict");
    expect(openConflictNotices).toHaveLength(1);
    const notice = openConflictNotices[0];
    expect(notice?.taskId).toBe("task-next");
    expect(visible?.steward?.filter((item) => item.kind === "open_conflict")).toHaveLength(1);
    expect(notice?.summary).toContain("conflicts with a proposal");
    expect(notice?.summary).not.toContain("accepted memory");
    expect(notice?.authorId).toBe("agent-b");
    expect(notice?.acceptedFactId).toBe(proposedFact?.factId);
    expect(notice?.proposedFactId).toBe("fact-attempt-2-tournament-start");
    expect(
      visible?.memoryFacts?.some(
        (item) =>
          item.factId === "fact-attempt-2-tournament-start" &&
          item.acceptance === "proposed" &&
          item.provenance.actorId === "agent-b",
      ),
    ).toBe(true);
    expect(visible?.attempts?.find((item) => item.attemptId === "attempt-2")?.write?.outcome).toBe(
      "conflict",
    );

    const recorded = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "runtime-write",
      event: {
        type: "record_runtime_models",
        taskId: "task-demo",
        attemptId: "attempt-1",
        generation: 1,
        leaseId: leaseIdFor(1),
        role: "implementer",
        requested: { model: "gpt-5.4" },
        actual: { model: "gpt-5.4" },
      },
    });
    expect(recorded.status).toBe(200);
    const done = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-demo",
      title: "Demo task",
      idempotencyKey: "complete-write",
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
          claimedOutcome: finished,
          artifactRevision: { type: "named", kind: "page", id: "t3-result" },
          evidence: [{ kind: "readback", ref: "thread:thread-1" }],
        },
      },
    });
    expect(done.status).toBe(200);
    const afterFinish = (await readCards(handler)).find((card) => card.taskId === "task-demo");
    expect(
      afterFinish?.attempts?.find((item) => item.attemptId === "attempt-1")?.write?.outcome,
    ).toBe("pending");
    expect(afterFinish?.memoryFacts?.some((item) => item.body === finished)).toBe(false);
    expect(
      afterFinish?.memoryFacts?.some(
        (item) => item.factId === proposedFact?.factId && item.acceptance === "proposed",
      ),
    ).toBe(true);

    const closed = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-next",
      title: "Next task",
      idempotencyKey: "runtime-next",
      event: {
        type: "record_runtime_models",
        taskId: "task-next",
        attemptId: "attempt-2",
        generation: 1,
        leaseId: leaseIdFor(1),
        role: "implementer",
        requested: { model: "gpt-5.4" },
        actual: { model: "gpt-5.4" },
      },
    });
    expect(closed.status).toBe(200);
    const finishedNext = await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
      taskId: "task-next",
      title: "Next task",
      idempotencyKey: "complete-next",
      threadId: "thread-2",
      runId: "run-2",
      event: {
        type: "submit_completion",
        completion: {
          version: "v1",
          taskId: "task-next",
          attemptId: "attempt-2",
          generation: 1,
          leaseId: leaseIdFor(1),
          claimedOutcome: "Finished the conflicting proposal.",
          artifactRevision: { type: "named", kind: "page", id: "t3-result" },
          evidence: [{ kind: "readback", ref: "thread:thread-2" }],
        },
      },
    });
    expect(finishedNext.status).toBe(200);
    const stayed = (await readCards(handler)).find((card) => card.taskId === "task-next");
    expect(stayed?.attempts?.find((item) => item.attemptId === "attempt-2")?.write?.outcome).toBe(
      "conflict",
    );
    expect(
      stayed?.memoryFacts?.some((item) => item.body === "Finished the conflicting proposal."),
    ).toBe(false);
    expect(stayed?.steward?.some((item) => item.kind === "open_conflict")).toBe(true);
    if (notice?.conflictId == null) throw new Error("expected an open steward conflict");

    const resolved = await postJson(handler, ADAPTER_MEMORY_RESOLVE_PATH, {
      conflictId: notice.conflictId,
      action: "correct",
      body: resolution,
    });
    expect(resolved.status).toBe(200);
    const applied = (await resolved.json()) as { readonly factIds: readonly string[] };
    expect(applied.factIds.length).toBeGreaterThan(0);

    const settled = (await readCards(handler)).find((card) => card.taskId === "task-next");
    expect(settled?.steward?.find((item) => item.kind === "open_conflict")).toBeUndefined();
    expect(
      settled?.memoryFacts?.some(
        (item) =>
          item.body === resolution &&
          item.acceptance === "accepted" &&
          item.provenance.actorId === "jim",
      ),
    ).toBe(true);
    expect(
      settled?.memoryFacts?.find((item) => item.factId === proposedFact?.factId),
    ).toMatchObject({
      acceptance: "superseded",
      provenance: { actorId: "t3-codex" },
    });
    expect(
      settled?.memoryFacts?.find((item) => item.factId === "fact-attempt-2-tournament-start"),
    ).toMatchObject({ acceptance: "superseded" });

    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-later",
          title: "Later task",
          idempotencyKey: "intake-later",
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
          taskId: "task-later",
          column: "Ready",
          idempotencyKey: "ready-later",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_EVENT_PATH, {
          taskId: "task-later",
          title: "Later task",
          idempotencyKey: "assign-later",
          event: {
            type: "assign",
            assignment: {
              ...assignmentExample,
              taskId: "task-later",
              attemptId: "attempt-3",
              assignmentId: "assignment-later",
              workerId: "agent-c",
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
          taskId: "task-later",
          column: "Running",
          idempotencyKey: "run-later",
        })
      ).status,
    ).toBe(200);
    expect(prompts[2]).toContain(resolution);
    expect(prompts[2]).not.toContain(`proposed, not accepted: ${fact}`);
    expect(prompts[2]).not.toContain(conflict);
    const later = (await readCards(handler)).find((card) => card.taskId === "task-later");
    expect(
      later?.attempts?.find((item) => item.attemptId === "attempt-3")?.read.memoryVersions,
    ).toEqual(expect.arrayContaining([...applied.factIds]));
  });

  it("supplies the launch memory package and stores the read only after commit", async () => {
    const decision = "Saturday games start at 7:00.";
    const prompts: string[] = [];
    const { handler, stateDir } = handlerFor(undefined, {
      ...allowRuns,
      launch: (input) => {
        prompts.push(input.prompt);
        return Effect.succeed(activeLaunch());
      },
    });
    const database = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    submitMemorySync(
      database,
      {
        version: "v1",
        submissionId: "submission-start",
        idempotencyKey: "key-start",
        projectId: "usba",
        authorId: "jim",
        taskId: "task-seed",
        attemptId: "attempt-seed",
        evidence: [{ evidenceId: "evidence-start", note: "The schedule file says so." }],
        expectedVersions: [],
        intent: "accept",
        facts: [
          {
            identity: "tournament-start",
            fact: {
              acceptance: "proposed",
              factId: "fact-start",
              projectId: "usba",
              kind: "Decision",
              body: decision,
              provenance: { actorId: "jim", at: "2026-10-24T06:00:00Z" },
              validity: { from: "2026-10-24T06:00:00Z", until: null },
            },
          },
        ],
        relationships: [],
      },
      "jim",
    );
    database.close();

    const request = {
      projectId: "usba",
      taskId: "task-live",
      attemptId: "attempt-live",
      authorId: "codex-t3",
      runtime: "codex",
      repoCommit: exampleRepoCommit,
      requirements: "The tournament page shows the new schedule.",
      authorizationScope: "usba-web",
      createdAt: "2026-10-24T06:00:00Z",
    };
    const supplied = await postJson(handler, ADAPTER_MEMORY_SUPPLY_PATH, request);
    expect(supplied.status).toBe(200);
    const body = (await supplied.json()) as {
      readonly lines: readonly string[];
      readonly writeToken: string;
      readonly digest: string;
    };
    expect(body.lines.join("\n")).toContain(decision);
    expect(body.lines.join("\n")).toContain(ADAPTER_MEMORY_WRITE_PATH);
    expect(body.lines.join("\n")).toContain(`Memory write token: ${body.writeToken}`);
    expect(body.lines.join("\n")).toContain("This attempt has one write");
    expect(body.lines.join("\n")).toContain("attempt-live");

    const before = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    expect(readAttemptActivitySync(before).some((item) => item.attemptId === "attempt-live")).toBe(
      false,
    );
    before.close();

    const wrong = await postJson(handler, ADAPTER_MEMORY_COMMIT_PATH, {
      ...request,
      writeToken: body.writeToken,
      digest: "b".repeat(32),
    });
    expect(wrong.status).toBe(409);

    const committed = await postJson(handler, ADAPTER_MEMORY_COMMIT_PATH, {
      ...request,
      writeToken: body.writeToken,
      digest: body.digest,
    });
    expect(committed.status).toBe(200);
    const saved = openMemoryDatabase(NodePath.join(stateDir, "memory.db"));
    expect(readAttemptActivitySync(saved).some((item) => item.attemptId === "attempt-live")).toBe(
      true,
    );
    saved.close();

    const otherToken = `wt-${"cd".repeat(16)}`;
    const mismatched = await postJson(handler, ADAPTER_MEMORY_COMMIT_PATH, {
      ...request,
      writeToken: otherToken,
      digest: body.digest,
    });
    expect(mismatched.status).toBe(409);

    await reachAssigned(handler);
    const moved = await postJson(handler, ADAPTER_BOARD_MOVE_PATH, {
      taskId: "task-demo",
      column: "Running",
      idempotencyKey: "launch-supplied",
    });
    expect(moved.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(decision);
    expect(prompts[0]).toContain(ADAPTER_MEMORY_WRITE_PATH);
    expect(prompts[0]).toContain("This attempt has one write");
    expect(prompts[0]).toContain("Memory write token:");
  });
});
