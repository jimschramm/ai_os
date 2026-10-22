import { assert, it } from "@effect/vitest";
import { applySequence, happyPathEvents, intakeV2Example } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import { decodeAdapterBoard } from "./board.ts";
import { encodeAdapterBoardWire, makeAdapterBoardHub } from "./boardHub.ts";

const at = "2026-10-21T18:00:00Z";

const card = (taskId: string, title: string, revision = 0) =>
  encodeAdapterBoardWire([
    {
      taskId,
      title,
      state: { phase: "idle" },
      threadId: null,
      runId: null,
      revision,
      updatedAt: at,
    },
  ]);

it.effect("upserts cards by task id and leaves the others", () =>
  Effect.sync(() => {
    const hub = makeAdapterBoardHub();
    assert.equal(hub.upsert("nope"), "invalid");
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.length, 0);

    assert.equal(hub.upsert(card("task-a", "First")), "ok");
    assert.equal(hub.upsert(card("task-b", "Second")), "ok");
    assert.equal(hub.upsert("[]"), "ok");
    const both = decodeAdapterBoard(hub.snapshot());
    assert.deepStrictEqual(
      both?.map((item) => item.taskId),
      ["task-a", "task-b"],
    );

    const storedRevision = decodeAdapterBoard(hub.snapshot())?.find(
      (item) => item.taskId === "task-a",
    )?.revision;
    assert.equal(hub.upsert(card("task-a", "Updated", storedRevision)), "ok");
    const updated = decodeAdapterBoard(hub.snapshot());
    assert.deepStrictEqual(
      updated?.map((item) => [item.taskId, item.title]),
      [
        ["task-a", "Updated"],
        ["task-b", "Second"],
      ],
    );

    assert.equal(hub.upsert("nope"), "invalid");
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.length, 2);

    assert.equal(hub.replace(card("task-c", "Only")), true);
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-c"],
    );
  }),
);

const rawCard = (patch: Record<string, unknown>) =>
  JSON.stringify([
    {
      taskId: "task-a",
      title: "First",
      state: { phase: "idle" },
      threadId: null,
      updatedAt: at,
      ...patch,
    },
  ]);

it.effect("rejects an empty id, a blank title, and a timestamp that is not RFC3339 Z", () =>
  Effect.sync(() => {
    const hub = makeAdapterBoardHub();
    assert.equal(hub.upsert(card("task-a", "First")), "ok");
    for (const payload of [
      rawCard({ taskId: "" }),
      rawCard({ taskId: " has space" }),
      rawCard({ title: "" }),
      rawCard({ title: "  " }),
      rawCard({ title: " padded " }),
      rawCard({ threadId: "" }),
      rawCard({ updatedAt: "yesterday" }),
      rawCard({ updatedAt: "2026-10-21T18:00:00" }),
      rawCard({ updatedAt: "2026-10-21T18:00:00+00:00" }),
      rawCard({ updatedAt: "2026-13-21T18:00:00Z" }),
    ]) {
      assert.equal(hub.upsert(payload), "invalid");
    }
    assert.equal(hub.upsert(rawCard({ updatedAt: "2026-10-21T18:00:00.000Z", revision: 1 })), "ok");
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a"],
    );
  }),
);

it.effect("rejects a stale revision and a snapshot that changes phase", () =>
  Effect.gen(function* () {
    const hub = makeAdapterBoardHub();
    assert.equal(hub.upsert(card("task-a", "First")), "ok");
    assert.equal(hub.upsert(card("task-a", "Stale title", 0)), "stale");
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.[0]?.title, "First");

    const requested = encodeAdapterBoardWire([
      {
        taskId: "task-a",
        title: "First",
        state: { phase: "requested", intake: intakeV2Example },
        threadId: null,
        runId: null,
        revision: 1,
        updatedAt: at,
      },
    ]);
    assert.equal(hub.upsert(requested), "forbidden");
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.[0]?.state.phase, "idle");

    const accepted = yield* applySequence(happyPathEvents);
    const done = encodeAdapterBoardWire([
      {
        taskId: "task-done",
        title: "Already accepted",
        state: accepted,
        threadId: null,
        runId: null,
        revision: 0,
        updatedAt: at,
      },
    ]);
    assert.equal(hub.upsert(done), "forbidden");
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a"],
    );

    const assigned = yield* applySequence(happyPathEvents.slice(0, 3));
    assert.equal(
      hub.upsert(
        encodeAdapterBoardWire([
          {
            taskId: "task-ready",
            title: "Queued",
            state: assigned,
            threadId: null,
            runId: null,
            revision: 0,
            updatedAt: at,
          },
        ]),
      ),
      "ok",
    );
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a", "task-ready"],
    );
  }),
);
