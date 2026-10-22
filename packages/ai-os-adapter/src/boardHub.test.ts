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
