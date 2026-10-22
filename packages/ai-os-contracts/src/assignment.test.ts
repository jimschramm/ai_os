import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { assignmentExample, exampleRepoCommit } from "./examples.ts";
import { decodeAssignmentV1, decodeContextPackageSnapshotV1 } from "./assignment.ts";

it.effect("decodes an assignment whose context package is an exact snapshot", () =>
  Effect.gen(function* () {
    const assignment = yield* decodeAssignmentV1(assignmentExample);
    assert.strictEqual(assignment.contextPackage.repoCommit, exampleRepoCommit);
    assert.deepStrictEqual(assignment.contextPackage.memoryVersions, ["decision-12"]);
    assert.deepStrictEqual(assignment.implementerModel, { model: "gpt-5.4" });
    assert.strictEqual(assignment.instanceId, undefined);
    const withInstance = yield* decodeAssignmentV1({ ...assignmentExample, instanceId: "grok" });
    assert.strictEqual(withInstance.instanceId, "grok");
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
        repoCommit: exampleRepoCommit,
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

it.effect("deep-copies and freezes the context snapshot at decode", () =>
  Effect.gen(function* () {
    const memoryVersions = ["decision-12"];
    const input = {
      ...assignmentExample,
      contextPackage: {
        ...assignmentExample.contextPackage,
        memoryVersions,
        requirements: "The tournament page shows the new schedule.",
      },
    };
    const decoded = yield* decodeAssignmentV1(input);
    memoryVersions.push("caller-mutation");
    input.contextPackage.requirements = "changed by caller";
    assert.deepStrictEqual(decoded.contextPackage.memoryVersions, ["decision-12"]);
    assert.strictEqual(
      decoded.contextPackage.requirements,
      "The tournament page shows the new schedule.",
    );
    assert.strictEqual(Object.isFrozen(input), false);
    assert.strictEqual(Object.isFrozen(decoded), true);
    assert.throws(() => {
      (decoded.contextPackage.memoryVersions as Array<string>).push("stored-mutation");
    });
  }),
);
