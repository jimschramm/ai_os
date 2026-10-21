import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ConversationId,
  canonicalConversationId,
  canonicalInstant,
  epochMs,
  fingerprintOf,
  timeAtOrBefore,
  timeBefore,
} from "./canonical.ts";
import { GitSha, IsoDateTime, ModelRef, strictParse } from "./common.ts";
import { decodeHeartbeatV1 } from "./progress.ts";

const decodeInstant = Schema.decodeUnknownEffect(IsoDateTime, strictParse);
const decodeConversation = Schema.decodeUnknownEffect(ConversationId, strictParse);
const decodeModel = Schema.decodeUnknownEffect(ModelRef, strictParse);
const decodeGitSha = Schema.decodeUnknownEffect(GitSha, strictParse);

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

it.effect("accepts only real UTC instants and keeps the submitted text", () =>
  Effect.gen(function* () {
    const fraction = "2026-10-21T15:00:00.1Z";
    assert.strictEqual(canonicalInstant(fraction), fraction);
    const decoded = yield* decodeInstant(fraction);
    assert.strictEqual(decoded, fraction);
    assert.strictEqual(canonicalInstant("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00Z");
    assert.strictEqual(canonicalInstant("2000-02-29T23:59:59Z"), "2000-02-29T23:59:59Z");
    const rejected = [
      "2023-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-00-01T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-04-00T00:00:00Z",
      "2026-10-21T24:00:00Z",
      "2026-10-21T23:60:00Z",
      "2026-10-21T23:59:60Z",
      "2026-10-21T15:00:00z",
      "2026-10-21T15:00:00+00:00",
    ];
    for (const value of rejected) {
      assert.strictEqual(canonicalInstant(value), null);
      assert.strictEqual(epochMs(value), null);
      const exit = yield* Effect.exit(decodeInstant(value));
      assert.strictEqual(Exit.isFailure(exit), true);
    }
  }),
);

it.effect("keeps conversation ids case-sensitive and folds only case-insensitive ids", () =>
  Effect.gen(function* () {
    const trimmed = yield* decodeConversation(" Thread-A ");
    assert.strictEqual(trimmed, "Thread-A");
    assert.strictEqual(canonicalConversationId("thread-a"), "thread-a");
    assert.strictEqual(trimmed === "thread-a", false);
    assert.strictEqual(canonicalConversationId("Thread A"), null);
    assert.strictEqual(canonicalConversationId("Thread-\u200bA"), null);
    assert.strictEqual(canonicalConversationId("Thread-\u0000A"), null);
    const model = yield* decodeModel("OpenAI/GPT-5.4");
    assert.strictEqual(model.provider, "openai");
    assert.strictEqual(model.model, "gpt-5.4");
    const sha = yield* decodeGitSha(`${"A".repeat(40)}`);
    assert.strictEqual(sha, "a".repeat(40));
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
