import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeAdapterBoard } from "./board.ts";
import { encodeAdapterBoardWire, makeAdapterBoardHub } from "./boardHub.ts";

const at = "2026-10-21T18:00:00Z";

const card = (taskId: string, title: string) =>
  encodeAdapterBoardWire([
    {
      taskId,
      title,
      state: { phase: "idle" },
      threadId: null,
      updatedAt: at,
    },
  ]);

it.effect("upserts cards by task id and leaves the others", () =>
  Effect.sync(() => {
    const hub = makeAdapterBoardHub();
    assert.equal(hub.upsert("nope"), false);
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.length, 0);

    assert.equal(hub.upsert(card("task-a", "First")), true);
    assert.equal(hub.upsert(card("task-b", "Second")), true);
    assert.equal(hub.upsert("[]"), true);
    const both = decodeAdapterBoard(hub.snapshot());
    assert.deepStrictEqual(
      both?.map((item) => item.taskId),
      ["task-a", "task-b"],
    );

    assert.equal(hub.upsert(card("task-a", "Updated")), true);
    const updated = decodeAdapterBoard(hub.snapshot());
    assert.deepStrictEqual(
      updated?.map((item) => [item.taskId, item.title]),
      [
        ["task-a", "Updated"],
        ["task-b", "Second"],
      ],
    );

    assert.equal(hub.upsert("nope"), false);
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
    assert.equal(hub.upsert(card("task-a", "First")), true);
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
      assert.equal(hub.upsert(payload), false);
    }
    assert.equal(hub.upsert(rawCard({ updatedAt: "2026-10-21T18:00:00.000Z" })), true);
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a"],
    );
  }),
);
