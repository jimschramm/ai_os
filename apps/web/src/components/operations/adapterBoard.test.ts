import { assert, it } from "@effect/vitest";
import {
  applySequence,
  assignmentExample,
  intakeV2Example,
  taskLinkFor,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import { encodeAdapterBoard } from "@t3tools/ai-os-adapter/board";

import { tasksForBoard } from "./adapterBoard";
import {
  applyAdapterBoardPayload,
  readAdapterBoardSnapshot,
  subscribeAdapterBoard,
} from "./adapterFeed";
import { tasksForProject } from "./model";

const at = "2026-10-21T18:00:00Z";

const assigned = (taskId: string) =>
  applySequence([
    { type: "intake", intake: intakeV2Example },
    {
      type: "acknowledge",
      acknowledgment: {
        version: "v1",
        taskId,
        taskLink: taskLinkFor(taskId),
        durable: true,
        receivedAt: at,
      },
    },
    {
      type: "assign",
      assignment: {
        ...structuredClone(assignmentExample),
        taskId,
        attemptId: `${taskId}-attempt-1`,
        assignmentId: `${taskId}-assignment-1`,
      },
    },
  ]);

it.effect("reads adapter cards and keeps fixture tasks as the fallback", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(tasksForBoard("usba", []), tasksForProject("usba"));

    const live = yield* assigned("task-usba-page");
    const withLive = tasksForBoard("usba", [
      {
        taskId: "task-usba-page",
        title: "Live page",
        state: live,
        threadId: "t3-thread-1",
        updatedAt: at,
      },
    ]);
    assert.equal(
      withLive.some((task) => task.id === "task-usba-page" && task.phase === "assigned"),
      true,
    );
    assert.equal(
      withLive.some((task) => task.id === "saturday-copy"),
      true,
    );
    assert.strictEqual(
      withLive.filter((task) => task.projectId === "usba").length,
      withLive.length,
    );

    const replacement = yield* assigned("saturday-copy");
    const replaced = tasksForBoard("usba", [
      {
        taskId: "saturday-copy",
        title: "Live Saturday",
        state: replacement,
        threadId: "t3-thread-2",
        updatedAt: at,
      },
    ]);
    assert.strictEqual(replaced.length, tasksForProject("usba").length);
    assert.strictEqual(replaced.find((task) => task.id === "saturday-copy")?.phase, "assigned");
    assert.strictEqual(
      replaced.find((task) => task.id === "saturday-copy")?.title,
      "Live Saturday",
    );
  }),
);

it.effect("re-renders from a feed payload and falls back when the payload is empty", () =>
  Effect.gen(function* () {
    const live = yield* assigned("task-usba-page");
    const payload = encodeAdapterBoard([
      {
        taskId: "task-usba-page",
        title: "Live page",
        state: live,
        threadId: "t3-thread-1",
        updatedAt: at,
      },
    ]);
    const seen: number[] = [];
    const stop = subscribeAdapterBoard(() => {
      seen.push(readAdapterBoardSnapshot().length);
    });
    assert.strictEqual(applyAdapterBoardPayload(payload), true);
    assert.strictEqual(seen.at(-1), 1);
    const shown = tasksForBoard("usba", readAdapterBoardSnapshot());
    assert.equal(
      shown.some((task) => task.id === "task-usba-page" && task.title === "Live page"),
      true,
    );
    assert.strictEqual(applyAdapterBoardPayload("not-json"), false);
    assert.strictEqual(applyAdapterBoardPayload("[]"), true);
    assert.deepStrictEqual(
      tasksForBoard("usba", readAdapterBoardSnapshot()),
      tasksForProject("usba"),
    );
    stop();
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        applyAdapterBoardPayload("[]");
      }),
    ),
  ),
);
