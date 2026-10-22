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

it.effect("shows fixtures only when the live feed is empty", () =>
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
    assert.deepStrictEqual(
      withLive.map((task) => task.id),
      ["task-usba-page"],
    );
    assert.strictEqual(withLive[0]?.title, "Live page");
    assert.equal(
      withLive.some((task) => task.id === "saturday-copy"),
      false,
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
    assert.deepStrictEqual(
      replaced.map((task) => task.id),
      ["saturday-copy"],
    );
    assert.strictEqual(replaced[0]?.phase, "assigned");
    assert.strictEqual(replaced[0]?.title, "Live Saturday");
    assert.deepStrictEqual(
      tasksForBoard(
        "usba",
        [
          {
            taskId: "saturday-copy",
            title: "Live Saturday",
            state: replacement,
            threadId: "t3-thread-2",
            updatedAt: at,
          },
        ],
        true,
      ).map((task) => task.id).length,
      tasksForProject("usba").length,
    );
  }),
);

it.effect("keeps a live card whose project is not one of the fixtures", () =>
  Effect.gen(function* () {
    const live = yield* applySequence([
      {
        type: "intake",
        intake: { ...intakeV2Example, projectId: "local-repo", workspaceId: "local-repo" },
      },
      {
        type: "acknowledge",
        acknowledgment: {
          version: "v1",
          taskId: "task-local",
          taskLink: taskLinkFor("task-local"),
          durable: true,
          receivedAt: at,
        },
      },
      {
        type: "assign",
        assignment: {
          ...structuredClone(assignmentExample),
          taskId: "task-local",
          attemptId: "task-local-attempt-1",
          assignmentId: "task-local-assignment-1",
        },
      },
    ]);
    const card = {
      taskId: "task-local",
      title: "Local repo task",
      state: live,
      threadId: "t3-thread-local",
      updatedAt: at,
    };
    const all = tasksForBoard(undefined, [card]);
    assert.deepStrictEqual(
      all.map((task) => task.id),
      ["task-local"],
    );
    assert.equal(
      all.some((task) => task.projectId === "personal"),
      false,
    );
    assert.equal(
      all.some((task) => task.projectId === "usba"),
      false,
    );
    const only = tasksForBoard("local-repo", [card]);
    assert.deepStrictEqual(
      only.map((task) => task.id),
      ["task-local"],
    );
    assert.deepStrictEqual(
      tasksForBoard("usba", [card]).map((task) => task.id),
      [],
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

it.effect("shows a requested task with no assignment", () =>
  Effect.gen(function* () {
    const requested = yield* applySequence([
      { type: "intake", intake: { ...intakeV2Example, projectId: "usba", workspaceId: "usba" } },
    ]);
    const shown = tasksForBoard("usba", [
      {
        taskId: "task-backlog",
        title: "Draft the brief",
        state: requested,
        threadId: null,
        updatedAt: at,
      },
    ]);
    assert.strictEqual(shown[0]?.phase, "requested");
    assert.strictEqual(shown[0]?.assignment, null);
    assert.strictEqual(shown[0]?.agent, "Unassigned");
    assert.strictEqual(shown[0]?.projectId, "usba");
  }),
);
