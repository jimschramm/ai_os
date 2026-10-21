import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { assignmentExample } from "./examples.ts";
import { decodeAssignmentV1, decodeContextPackageSnapshotV1 } from "./assignment.ts";

it.effect("decodes an assignment whose context package is an exact snapshot", () =>
  Effect.gen(function* () {
    const assignment = yield* decodeAssignmentV1(assignmentExample);
    assert.strictEqual(assignment.contextPackage.repoCommit, "abc123");
    assert.deepStrictEqual(assignment.contextPackage.memoryVersions, ["decision-12"]);
    assert.strictEqual(assignment.implementerModel, "gpt-5.4");
  }),
);

it.effect("rejects an assignment without a context package or an exact repo commit", () =>
  Effect.gen(function* () {
    const { contextPackage: _contextPackage, ...withoutPackage } = assignmentExample;
    const missingPackage = yield* Effect.exit(decodeAssignmentV1(withoutPackage));
    const blankCommit = yield* Effect.exit(
      decodeAssignmentV1({
        ...assignmentExample,
        contextPackage: { ...assignmentExample.contextPackage, repoCommit: "" },
      }),
    );
    const missingCreatedAt = yield* Effect.exit(
      decodeContextPackageSnapshotV1({
        requirements: assignmentExample.contextPackage.requirements,
        memoryVersions: [],
        repoCommit: "abc123",
        authorizationScope: "usba-web",
      }),
    );
    assert.strictEqual(Exit.isFailure(missingPackage), true);
    assert.strictEqual(Exit.isFailure(blankCommit), true);
    assert.strictEqual(Exit.isFailure(missingCreatedAt), true);
  }),
);

it.effect("rejects vector hits so they never enter a ContextPackage", () =>
  Effect.gen(function* () {
    const withVectorHits = yield* Effect.exit(
      decodeContextPackageSnapshotV1({
        ...assignmentExample.contextPackage,
        vectorHits: ["candidate-node"],
      }),
    );
    assert.strictEqual(Exit.isFailure(withVectorHits), true);
  }),
);
