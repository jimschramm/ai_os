import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { taskLinkFor } from "./common.ts";
import { acknowledgmentExample, intakeExample } from "./examples.ts";
import { decodeIntakeAcknowledgmentV1, decodeIntakeV1, decodeIntakeV2 } from "./intake.ts";

const pr3Intake = {
  version: "v1",
  workspaceId: "personal",
  projectId: "usba",
  request:
    "Update the USBA tournament page, verify it, and have Marketing prepare the announcement.",
  constraints: ["Keep the public page available during the update."],
  acceptanceCriteria: ["The tournament page shows the new schedule."],
  authorization: { kind: "standing", scope: "usba-web" },
};

const validIntake = {
  version: "v1",
  workspaceId: "personal",
  projectId: "usba",
  request: "Update the USBA tournament page.",
  constraints: [],
  acceptanceCriteria: ["The tournament page shows the new schedule."],
  authorization: { kind: "standing", scope: "usba-web" },
};

it.effect("decodes a v1 intake and the durable acknowledgment example", () =>
  Effect.gen(function* () {
    const intake = yield* decodeIntakeV1(validIntake);
    const pr3 = yield* decodeIntakeV1(pr3Intake);
    assert.strictEqual("originatingConversationId" in intake, false);
    assert.strictEqual(pr3.request, intakeExample.request);
    assert.strictEqual("originatingConversationId" in pr3, false);
    const v2 = yield* decodeIntakeV2({
      ...pr3Intake,
      originatingConversationId: " Grok-Thread-1 ",
    });
    assert.strictEqual(v2.originatingConversationId, "Grok-Thread-1");
    const v1WithConversation = yield* Effect.exit(
      decodeIntakeV1({ ...pr3Intake, originatingConversationId: "Grok-Thread-1" }),
    );
    const v2WithoutConversation = yield* Effect.exit(decodeIntakeV2(pr3Intake));
    assert.strictEqual(Exit.isFailure(v1WithConversation), true);
    assert.strictEqual(Exit.isFailure(v2WithoutConversation), true);
    assert.strictEqual(intake.projectId, "usba");
    assert.strictEqual(intake.authorization.kind, "standing");
    assert.strictEqual(
      intakeExample.acceptanceCriteria[0],
      "The tournament page shows the new schedule.",
    );
    assert.strictEqual(acknowledgmentExample.durable, true);
    assert.strictEqual(acknowledgmentExample.taskLink, taskLinkFor(acknowledgmentExample.taskId));
  }),
);

it.effect("rejects intake payloads that omit the request or acceptance criteria", () =>
  Effect.gen(function* () {
    const blankRequest = yield* Effect.exit(decodeIntakeV1({ ...validIntake, request: "   " }));
    const noCriteria = yield* Effect.exit(
      decodeIntakeV1({ ...validIntake, acceptanceCriteria: [] }),
    );
    const missingProject = yield* Effect.exit(
      decodeIntakeV1({ ...validIntake, projectId: undefined }),
    );
    assert.strictEqual(Exit.isFailure(blankRequest), true);
    assert.strictEqual(Exit.isFailure(noCriteria), true);
    assert.strictEqual(Exit.isFailure(missingProject), true);
  }),
);

it.effect("rejects confirmation that is not a durable receipt or that omits the task link", () =>
  Effect.gen(function* () {
    const notDurable = yield* Effect.exit(
      decodeIntakeAcknowledgmentV1({ ...acknowledgmentExample, durable: false }),
    );
    const missingLink = yield* Effect.exit(
      decodeIntakeAcknowledgmentV1({
        version: "v1",
        taskId: "task-usba-page",
        durable: true,
        receivedAt: "2026-10-21T14:00:00Z",
      }),
    );
    const linkForAnotherTask = yield* Effect.exit(
      decodeIntakeAcknowledgmentV1({
        ...acknowledgmentExample,
        taskLink: "ai-os://tasks/other-task",
      }),
    );
    assert.strictEqual(Exit.isFailure(notDurable), true);
    assert.strictEqual(Exit.isFailure(missingLink), true);
    assert.strictEqual(Exit.isFailure(linkForAnotherTask), true);
  }),
);

it.effect("rejects a task link that is not the exact ai-os task resource", () =>
  Effect.gen(function* () {
    const rejectLink = (taskLink: string) =>
      Effect.exit(
        decodeIntakeAcknowledgmentV1({
          ...acknowledgmentExample,
          taskLink,
        }),
      );
    const containsId = yield* rejectLink("not-a-uri-task-usba-page");
    const otherScheme = yield* rejectLink("https://evil.example/tasks/task-usba-page");
    const extraSegment = yield* rejectLink("ai-os://tasks/task-usba-page/extra");
    const query = yield* rejectLink("ai-os://tasks/task-usba-page?x=1");
    const fragment = yield* rejectLink("ai-os://tasks/task-usba-page#section");
    const otherHost = yield* rejectLink("ai-os://files/task-usba-page");
    const longerId = yield* rejectLink("ai-os://tasks/task-usba-page-more");
    const exact = yield* decodeIntakeAcknowledgmentV1({
      ...acknowledgmentExample,
      taskLink: taskLinkFor("task-usba-page"),
    });
    assert.strictEqual(Exit.isFailure(containsId), true);
    assert.strictEqual(Exit.isFailure(otherScheme), true);
    assert.strictEqual(Exit.isFailure(extraSegment), true);
    assert.strictEqual(Exit.isFailure(query), true);
    assert.strictEqual(Exit.isFailure(fragment), true);
    assert.strictEqual(Exit.isFailure(otherHost), true);
    assert.strictEqual(Exit.isFailure(longerId), true);
    assert.strictEqual(exact.taskLink, "ai-os://tasks/task-usba-page");
  }),
);
