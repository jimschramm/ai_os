import { assert, it } from "@effect/vitest";

import { eligibleImplementer, isAstraQa, isSolModel, qaWorkerFor } from "./roles.ts";

const sol = {
  workerId: "codex-t3",
  instanceId: "codex",
  model: { model: "gpt-5.6-sol" },
};
const astra = {
  workerId: "codex-astra",
  instanceId: "codex",
  model: { model: "gpt-6-astra" },
};
const sonnet = {
  workerId: "claude-qa",
  instanceId: "claude",
  model: { model: "claude-sonnet-5" },
};

it("treats Sol effort variants as one implementer family and Astra on Codex as its QA", () => {
  assert.strictEqual(isSolModel("gpt-6-sol"), true);
  assert.strictEqual(isSolModel("gpt-5.6-sol-high"), true);
  assert.strictEqual(isSolModel("gpt-6-astra"), false);
  assert.strictEqual(isAstraQa(astra), true);
  assert.strictEqual(isAstraQa({ ...astra, instanceId: "claude" }), false);
});

it("picks the configured implementer and refuses an advisory worker", () => {
  assert.deepStrictEqual(eligibleImplementer({ implementer: sol }), sol);
  assert.strictEqual(eligibleImplementer(undefined), null);
  assert.strictEqual(
    eligibleImplementer({
      implementer: { ...sol, instanceId: "antigravity" },
    }),
    null,
  );
});

it("uses Astra for Sol and the configured QA worker for anyone else", () => {
  assert.deepStrictEqual(qaWorkerFor({ implementer: sol, qa: astra }, "gpt-5.6-sol"), astra);
  assert.strictEqual(qaWorkerFor({ implementer: sol, qa: sonnet }, "gpt-6-sol"), null);
  assert.deepStrictEqual(qaWorkerFor({ qa: sonnet }, "gpt-5.4"), sonnet);
  assert.strictEqual(qaWorkerFor({ qa: astra }, "gpt-6-astra"), null);
  assert.strictEqual(
    qaWorkerFor({ qa: { ...sonnet, instanceId: "antigravity" } }, "gpt-5.4"),
    null,
  );
});
