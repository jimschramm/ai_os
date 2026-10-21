import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { epochMs, fingerprintOf, timeAtOrBefore, timeBefore } from "./canonical.ts";
import { decodeHeartbeatV1 } from "./progress.ts";

it.effect("compares instants numerically across fractional-second boundaries", () =>
  Effect.gen(function* () {
    assert.strictEqual(epochMs("2026-10-21T15:00:00.1Z"), epochMs("2026-10-21T15:00:00.100Z"));
    assert.strictEqual(timeBefore("2026-10-21T15:00:00Z", "2026-10-21T15:00:00.001Z"), true);
    assert.strictEqual(timeAtOrBefore("2026-10-21T15:00:00.1Z", "2026-10-21T15:00:00.100Z"), true);
    assert.strictEqual(timeBefore("2026-10-21T15:00:00.100Z", "2026-10-21T15:00:00.1Z"), false);
    const laterByAMillisecond = yield* decodeHeartbeatV1({
      version: "v1",
      taskId: "task-usba-page",
      attemptId: "attempt-1",
      generation: 1,
      leaseId: "lease-1",
      observedAt: "2026-10-21T15:00:00Z",
      leaseExpiresAt: "2026-10-21T15:00:00.001Z",
    });
    const earlier = yield* Effect.exit(
      decodeHeartbeatV1({
        version: "v1",
        taskId: "task-usba-page",
        attemptId: "attempt-1",
        generation: 1,
        leaseId: "lease-1",
        observedAt: "2026-10-21T15:00:00.001Z",
        leaseExpiresAt: "2026-10-21T15:00:00Z",
      }),
    );
    assert.strictEqual(laterByAMillisecond.leaseExpiresAt, "2026-10-21T15:00:00.001Z");
    assert.strictEqual(Exit.isFailure(earlier), true);
  }),
);

it.effect("fingerprints the payload rather than its key order", () =>
  Effect.sync(() => {
    const left = fingerprintOf({
      command: "transfer_ownership",
      taskId: "task-usba-page",
      ownerId: "t3-other",
      attemptId: "attempt-1",
    });
    const right = fingerprintOf({
      attemptId: "attempt-1",
      ownerId: "t3-other",
      taskId: "task-usba-page",
      command: "transfer_ownership",
    });
    const otherOwner = fingerprintOf({
      command: "transfer_ownership",
      taskId: "task-usba-page",
      attemptId: "attempt-1",
      ownerId: "t3-third",
    });
    assert.strictEqual(left, right);
    assert.strictEqual(left === otherOwner, false);
  }),
);
