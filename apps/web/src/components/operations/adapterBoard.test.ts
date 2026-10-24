import { assert, it } from "@effect/vitest";
import {
  applySequence,
  applySequenceEvent,
  assignmentExample,
  exampleRepoCommit,
  intakeV2Example,
  leaseIdFor,
  REWORK_CAP_LABEL,
  taskLinkFor,
  type SequenceState,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import { encodeAdapterBoard } from "@t3tools/ai-os-adapter/board";

import { tasksForBoard } from "./adapterBoard";
import { findingsCount } from "./boardVisuals";
import {
  applyAdapterBoardPayload,
  readAdapterBoardSnapshot,
  subscribeAdapterBoard,
} from "./adapterFeed";
import { blockerReason, columnFor, needsYou, qaStatusLabel, tasksForProject } from "./model";

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

it.effect("puts a capped rework on Blocked and in Needs you", () =>
  Effect.gen(function* () {
    const taskId = "task-usba-page";
    const attempt = `${taskId}-attempt-1`;
    const sha = (n: number) => ({ type: "git" as const, sha: n.toString(16).padStart(40, "0") });
    const finding = (n: number) => ({
      defect: `Defect ${n}.`,
      evidence: `Evidence ${n}.`,
      expectedBehavior: `Expected ${n}.`,
    });
    let state: SequenceState = yield* assigned(taskId);
    for (const round of [1, 2, 3]) {
      if (state.phase !== "executing") {
        state = yield* applySequenceEvent(state, { type: "start_execution" });
      }
      if (state.phase !== "executing") return yield* Effect.die("The round must be executing.");
      state = yield* applySequenceEvent(state, {
        type: "record_runtime_models",
        taskId,
        attemptId: attempt,
        generation: state.run.generation,
        leaseId: state.run.leaseId,
        role: "implementer",
        requested: { model: "gpt-5.4" },
        actual: { model: "gpt-5.4" },
      });
      if (state.phase !== "executing") return yield* Effect.die("The round must be executing.");
      state = yield* applySequenceEvent(state, {
        type: "submit_completion",
        completion: {
          version: "v1",
          taskId,
          attemptId: attempt,
          generation: state.run.generation,
          leaseId: leaseIdFor(state.run.generation),
          claimedOutcome: `Fix ${round}.`,
          artifactRevision: sha(round),
          evidence: [{ kind: "commit", ref: `commit-${round}` }],
        },
      });
      if (state.phase !== "awaiting_qa") return yield* Effect.die("The round must be in review.");
      state = yield* applySequenceEvent(state, {
        type: "record_runtime_models",
        taskId,
        attemptId: attempt,
        generation: state.run.generation,
        leaseId: state.run.leaseId,
        role: "reviewer",
        requested: { model: "claude-sonnet-5" },
        actual: { model: "claude-sonnet-5" },
      });
      state = yield* applySequenceEvent(state, {
        type: "qa",
        threadId: "thread-qa",
        qa: {
          version: "v1",
          taskId,
          attemptId: attempt,
          availability: "available",
          qaModel: "claude-sonnet-5",
          implementerModel: "gpt-5.4",
          verdict: "rework",
          artifactRevision: sha(round),
          findings: [finding(round)],
          ...(round === 3 ? { recommendation: "Ask Jim before another fix." } : {}),
        },
      });
    }
    const shown = tasksForBoard(undefined, [
      {
        taskId,
        title: "Tournament page",
        state,
        threadId: "t3-thread-1",
        updatedAt: at,
      },
    ]);
    const task = shown[0];
    assert.strictEqual(task?.phase, "rework_capped");
    assert.strictEqual(columnFor(task!), "Blocked");
    assert.strictEqual(qaStatusLabel(task!), REWORK_CAP_LABEL);
    assert.strictEqual(blockerReason(task!), REWORK_CAP_LABEL);
    assert.strictEqual(needsYou(shown)[0]?.nextAction, "Ask Jim before another fix.");
    assert.strictEqual(task?.reworkCap?.attemptedFixes.length, 3);
    assert.strictEqual(task?.reworkCap?.remainingIssue[0]?.defect, "Defect 3.");
  }),
);

it.effect("keeps advisory findings off the QA count", () =>
  Effect.gen(function* () {
    const review = {
      version: "v1" as const,
      taskId: assignmentExample.taskId,
      attemptId: assignmentExample.attemptId,
      generation: 1,
      leaseId: leaseIdFor(1),
      mode: "advisory" as const,
      commit: exampleRepoCommit,
      model: {
        requested: "gemini-4-argon-high",
        actual: null,
        unverified: true,
      },
      findings: [
        {
          commit: exampleRepoCommit,
          files: ["src/page.tsx"],
          evidence: "The page lists Saturday only.",
          suggestedAction: "Add Sunday to the schedule.",
        },
      ],
      artifacts: [],
      evidence: [{ kind: "commit" as const, ref: exampleRepoCommit }],
      sourcePath: "/tmp/source",
      scratchPath: "/tmp/scratch",
    };
    const reviewed = yield* applySequence([
      { type: "intake", intake: intakeV2Example },
      {
        type: "acknowledge",
        acknowledgment: {
          version: "v1",
          taskId: assignmentExample.taskId,
          taskLink: taskLinkFor(assignmentExample.taskId),
          durable: true,
          receivedAt: at,
        },
      },
      {
        type: "assign",
        assignment: { ...assignmentExample, taskType: "advisory" as const },
      },
      { type: "start_execution" },
      { type: "record_advisory", review },
      { type: "deliver_review", generation: 1, leaseId: leaseIdFor(1) },
    ]);
    const shown = tasksForBoard("usba", [
      {
        taskId: assignmentExample.taskId,
        title: "Advisory page",
        state: reviewed,
        threadId: null,
        updatedAt: at,
      },
    ]);
    const task = shown[0];
    assert.strictEqual(task?.phase, "review_delivered");
    assert.strictEqual(task?.qa, null);
    assert.strictEqual(task?.advisory?.findings.length, 1);
    assert.strictEqual(task?.advisory?.model.actual, null);
    assert.strictEqual(task?.advisory?.model.unverified, true);
    if (task === undefined) return;
    assert.strictEqual(findingsCount(task), 0);
  }),
);
