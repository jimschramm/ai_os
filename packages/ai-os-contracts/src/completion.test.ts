import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeCompletionSubmissionV1 } from "./completion.ts";
import { completionExample } from "./examples.ts";

it.effect("decodes a completion bound to an exact artifact revision and evidence", () =>
  Effect.gen(function* () {
    const completion = yield* decodeCompletionSubmissionV1(completionExample);
    assert.deepStrictEqual(completion.artifactRevision, { type: "git", sha: "abc1234" });
    assert.strictEqual(completion.evidence.length, 1);
    assert.strictEqual(completion.evidence[0]?.kind, "diff");
  }),
);

it.effect("rejects a claim that has no revision or no evidence", () =>
  Effect.gen(function* () {
    const { artifactRevision: _revision, ...withoutRevision } = completionExample;
    const missingRevision = yield* Effect.exit(decodeCompletionSubmissionV1(withoutRevision));
    const emptyEvidence = yield* Effect.exit(
      decodeCompletionSubmissionV1({ ...completionExample, evidence: [] }),
    );
    const claimOnly = yield* Effect.exit(
      decodeCompletionSubmissionV1({
        version: "v1",
        taskId: "task-usba-page",
        attemptId: "attempt-1",
        claimedOutcome: "Updated the tournament page.",
      }),
    );
    assert.strictEqual(Exit.isFailure(missingRevision), true);
    assert.strictEqual(Exit.isFailure(emptyEvidence), true);
    assert.strictEqual(Exit.isFailure(claimOnly), true);
  }),
);
