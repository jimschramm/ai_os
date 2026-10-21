import * as Schema from "effect/Schema";

import {
  ContractId,
  ContractText,
  ContractVersion,
  ModelRef,
  NonNegativeInt,
  strictParse,
} from "./common.ts";

export const UsagePlatformV1 = Schema.Literals([
  "dashboard",
  "conversation",
  "vscode",
  "t3",
  "local",
]);
export type UsagePlatformV1 = typeof UsagePlatformV1.Type;

export const UsageAttributionV1 = Schema.Struct({
  projectId: ContractId,
  taskId: ContractId,
  attemptId: ContractId,
  agentId: ContractId,
  platform: UsagePlatformV1,
  provider: ContractId,
  model: ModelRef,
});
export type UsageAttributionV1 = typeof UsageAttributionV1.Type;

export const ReportedTokensV1 = Schema.Struct({
  kind: Schema.Literal("reported_tokens"),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  attribution: UsageAttributionV1,
});
export type ReportedTokensV1 = typeof ReportedTokensV1.Type;

export const EstimatedCostV1 = Schema.Struct({
  kind: Schema.Literal("estimated_cost"),
  amountMinor: NonNegativeInt,
  currency: Schema.Literal("USD"),
  attribution: UsageAttributionV1,
});
export type EstimatedCostV1 = typeof EstimatedCostV1.Type;

export const SubscriptionAllocationV1 = Schema.Struct({
  kind: Schema.Literal("subscription_allocation"),
  shareBps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000)),
  attribution: UsageAttributionV1,
});
export type SubscriptionAllocationV1 = typeof SubscriptionAllocationV1.Type;

export const UnknownUsageV1 = Schema.Struct({
  kind: Schema.Literal("unknown"),
  reason: ContractText,
  attribution: UsageAttributionV1,
});
export type UnknownUsageV1 = typeof UnknownUsageV1.Type;

export const UsageMeasurementV1 = Schema.Union([
  ReportedTokensV1,
  EstimatedCostV1,
  SubscriptionAllocationV1,
  UnknownUsageV1,
]);
export type UsageMeasurementV1 = typeof UsageMeasurementV1.Type;

export const UsageLedgerV1 = Schema.Struct({
  version: ContractVersion,
  entries: Schema.Array(UsageMeasurementV1),
});
export type UsageLedgerV1 = typeof UsageLedgerV1.Type;

export interface UsageTotals {
  readonly reportedTokens: { readonly input: number; readonly output: number };
  readonly estimatedCostMinorUsd: number;
  readonly subscriptionAllocationBps: number;
  readonly unknownCount: number;
}

export const usageTotals = (entries: ReadonlyArray<UsageMeasurementV1>): UsageTotals => {
  let input = 0;
  let output = 0;
  let estimatedCostMinorUsd = 0;
  let subscriptionAllocationBps = 0;
  let unknownCount = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "reported_tokens":
        input += entry.inputTokens;
        output += entry.outputTokens;
        break;
      case "estimated_cost":
        estimatedCostMinorUsd += entry.amountMinor;
        break;
      case "subscription_allocation":
        subscriptionAllocationBps += entry.shareBps;
        break;
      case "unknown":
        unknownCount += 1;
        break;
    }
  }
  return {
    reportedTokens: { input, output },
    estimatedCostMinorUsd,
    subscriptionAllocationBps,
    unknownCount,
  };
};

export const decodeUsageMeasurementV1 = Schema.decodeUnknownEffect(UsageMeasurementV1, strictParse);
export const decodeUsageLedgerV1 = Schema.decodeUnknownEffect(UsageLedgerV1, strictParse);
