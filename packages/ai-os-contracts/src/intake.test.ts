import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { acknowledgmentExample, intakeExample } from "./examples.ts";
import { decodeIntakeAcknowledgmentV1, decodeIntakeV1 } from "./intake.ts";

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
    assert.strictEqual(intake.projectId, "usba");
    assert.strictEqual(intake.authorization.kind, "standing");
    assert.strictEqual(
      intakeExample.acceptanceCriteria[0],
      "The tournament page shows the new schedule.",
    );
    assert.strictEqual(acknowledgmentExample.durable, true);
    assert.strictEqual(acknowledgmentExample.taskLink.includes(acknowledgmentExample.taskId), true);
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
