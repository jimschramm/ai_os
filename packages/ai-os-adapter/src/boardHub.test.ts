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

it.effect("updates metadata by task id and refuses a new card", () =>
  Effect.sync(() => {
    const hub = makeAdapterBoardHub();
    assert.equal(hub.upsert("nope"), "invalid");
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.length, 0);
    assert.equal(hub.upsert(card("task-a", "First")), "forbidden");

    assert.equal(
      hub.replace(
        encodeAdapterBoardWire([
          {
            taskId: "task-a",
            title: "First",
            state: { phase: "idle" },
            threadId: null,
            runId: null,
            revision: 1,
            updatedAt: at,
          },
          {
            taskId: "task-b",
            title: "Second",
            state: { phase: "idle" },
            threadId: null,
            runId: null,
            revision: 1,
            updatedAt: at,
          },
        ]),
      ),
      true,
    );
    assert.equal(hub.upsert("[]"), "ok");
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a", "task-b"],
    );

    assert.equal(hub.upsert(card("task-a", "Updated", 1)), "ok");
    const updated = decodeAdapterBoard(hub.snapshot());
    assert.deepStrictEqual(
      updated?.map((item) => [item.taskId, item.title, item.revision]),
      [
        ["task-a", "Updated", 2],
        ["task-b", "Second", 1],
      ],
    );

    assert.equal(hub.upsert("nope"), "invalid");
    assert.strictEqual(decodeAdapterBoard(hub.snapshot())?.length, 2);

    assert.equal(hub.replace(card("task-c", "Only", 1)), true);
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
    assert.equal(hub.replace(card("task-a", "First", 1)), true);
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
    const runtimeRunId =
      "run:thread:thread%3Aproject%3A65a6f28e-e24a-4dee-81c1-d79c8b80a3f3%3Aac08f581-66bd-486e-978d-d4b6371c884e:ordinal:1";
    assert.equal(
      hub.upsert(
        rawCard({
          revision: 2,
          threadId: "thread:project:65a6f28e-e24a-4dee-81c1-d79c8b80a3f3:ac08f581",
          runId: runtimeRunId,
        }),
      ),
      "ok",
    );
    assert.strictEqual(
      decodeAdapterBoard(hub.snapshot())?.find((item) => item.taskId === "task-a")?.runId,
      runtimeRunId,
    );
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a"],
    );
  }),
);

it.effect("rejects a stale revision and a snapshot that creates a phase", () =>
  Effect.gen(function* () {
    const hub = makeAdapterBoardHub();
    assert.equal(hub.replace(card("task-a", "First", 1)), true);
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

    const assigned = yield* applySequence(happyPathEvents.slice(0, 3));
    const acknowledged = yield* applySequence(happyPathEvents.slice(0, 2));
    for (const [taskId, title, state] of [
      ["task-requested", "Backlog", { phase: "requested" as const, intake: intakeV2Example }],
      ["task-acked", "Acknowledged", acknowledged],
      ["task-ready", "Queued", assigned],
    ] as const) {
      assert.equal(
        hub.upsert(
          encodeAdapterBoardWire([
            {
              taskId,
              title,
              state,
              threadId: null,
              runId: null,
              revision: 0,
              updatedAt: at,
            },
          ]),
        ),
        "forbidden",
      );
    }
    assert.deepStrictEqual(
      decodeAdapterBoard(hub.snapshot())?.map((item) => item.taskId),
      ["task-a"],
    );
  }),
);
