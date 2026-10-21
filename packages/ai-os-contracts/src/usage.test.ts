import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeUsageLedgerV1, decodeUsageMeasurementV1, usageTotals } from "./usage.ts";

const attribution = {
  projectId: "usba",
  taskId: "task-usba-page",
  attemptId: "attempt-1",
  agentId: "codex",
  platform: "t3",
  provider: "openai",
  model: "gpt-5.4",
};

it.effect("keeps reported tokens, estimated cost, subscription use, and unknown distinct", () =>
  Effect.gen(function* () {
    const tokens = yield* decodeUsageMeasurementV1({
      kind: "reported_tokens",
      inputTokens: 10,
      outputTokens: 4,
      attribution,
    });
    const cost = yield* decodeUsageMeasurementV1({
      kind: "estimated_cost",
      amountMinor: 250,
      currency: "USD",
      attribution: { ...attribution, provider: "azure", model: "azure/gpt-5.4" },
    });
    const subscription = yield* decodeUsageMeasurementV1({
      kind: "subscription_allocation",
      shareBps: 500,
      attribution,
    });
    const unknown = yield* decodeUsageMeasurementV1({
      kind: "unknown",
      reason: "The provider returned no usage.",
      attribution,
    });
    const totals = usageTotals([tokens, cost, subscription, unknown]);
    assert.deepStrictEqual(totals.reportedTokens, { input: 10, output: 4 });
    assert.strictEqual(totals.estimatedCostMinorUsd, 250);
    assert.strictEqual(totals.subscriptionAllocationBps, 500);
    assert.strictEqual(totals.unknownCount, 1);
    assert.strictEqual("total" in totals, false);
    if (tokens.kind !== "reported_tokens" || cost.kind !== "estimated_cost") {
      return yield* Effect.die("Usage kinds must stay distinct.");
    }
    assert.deepStrictEqual(cost.attribution.model, { provider: "azure", model: "gpt-5.4" });
    assert.strictEqual(tokens.inputTokens, 10);
  }),
);

it.effect("rejects a measurement or ledger that mixes usage kinds", () =>
  Effect.gen(function* () {
    const mixed = yield* Effect.exit(
      decodeUsageMeasurementV1({
        kind: "reported_tokens",
        inputTokens: 10,
        outputTokens: 4,
        amountMinor: 250,
        attribution,
      }),
    );
    const unknownWithTokens = yield* Effect.exit(
      decodeUsageMeasurementV1({
        kind: "unknown",
        reason: "Missing usage.",
        inputTokens: 10,
        attribution,
      }),
    );
    const overShare = yield* Effect.exit(
      decodeUsageMeasurementV1({
        kind: "subscription_allocation",
        shareBps: 10_001,
        attribution,
      }),
    );
    const totaled = yield* Effect.exit(
      decodeUsageLedgerV1({
        version: "v1",
        entries: [{ kind: "unknown", reason: "Missing usage.", attribution }],
        total: 10,
      }),
    );
    assert.strictEqual(Exit.isFailure(mixed), true);
    assert.strictEqual(Exit.isFailure(unknownWithTokens), true);
    assert.strictEqual(Exit.isFailure(overShare), true);
    assert.strictEqual(Exit.isFailure(totaled), true);
  }),
);
