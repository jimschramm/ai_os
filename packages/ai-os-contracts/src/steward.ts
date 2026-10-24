import * as Schema from "effect/Schema";

import { ContractId, ContractText, strictParse } from "./common.ts";
import type { MemoryFactV1 } from "./memory.ts";
import type { MemoryLedgerV1 } from "./submission.ts";
import type { AttemptMemoryActivityV1 } from "./taskMemory.ts";

export const StewardNoticeKindV1 = Schema.Literals(["open_conflict", "missing_write"]);
export type StewardNoticeKindV1 = typeof StewardNoticeKindV1.Type;

/**
 * A steward notice is shown on the operations board the web already subscribes to.
 * That Needs you list is the notification channel. There is no separate messenger.
 */
export const StewardNoticeV1 = Schema.Struct({
  noticeId: ContractId,
  projectId: ContractId,
  taskId: ContractId,
  kind: StewardNoticeKindV1,
  authorId: ContractId,
  summary: ContractText,
  conflictId: Schema.NullOr(ContractId),
  attemptId: Schema.NullOr(ContractId),
  acceptedFactId: Schema.NullOr(ContractId),
  proposedFactId: Schema.NullOr(ContractId),
});
export type StewardNoticeV1 = typeof StewardNoticeV1.Type;

export const decodeStewardNoticeV1 = Schema.decodeUnknownSync(StewardNoticeV1, strictParse);

const fitId = (prefix: string, key: string): string => {
  const joined = `${prefix}-${key}`;
  if (joined.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(joined)) return joined;
  const compact = key.replace(/[^A-Za-z0-9._:-]/gu, "").slice(0, 80);
  return `${prefix}-${compact.length > 0 ? compact : "notice"}`;
};

const clip = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
};

const factBody = (facts: readonly MemoryFactV1[], factId: string): string =>
  facts.find((fact) => fact.factId === factId)?.body ?? factId;

/**
 * Open conflicts, and attempts that read memory without writing.
 * A proposal, including an explicit no-change explanation, counts as a write.
 */
export const reviewSteward = (
  ledger: MemoryLedgerV1,
  activity: readonly AttemptMemoryActivityV1[],
): readonly StewardNoticeV1[] => {
  const notices: StewardNoticeV1[] = [];
  for (const item of activity) {
    if (item.write !== null) continue;
    const summary = clip(
      `${item.authorId} read memory on ${item.attemptId} and did not write findings.`,
    );
    notices.push(
      decodeStewardNoticeV1({
        noticeId: fitId("steward-write", item.attemptId),
        projectId: item.projectId,
        taskId: item.taskId,
        kind: "missing_write",
        authorId: item.authorId,
        summary,
        conflictId: null,
        attemptId: item.attemptId,
        acceptedFactId: null,
        proposedFactId: null,
      }),
    );
  }
  for (const conflict of ledger.conflicts) {
    if (conflict.resolvedBySubmissionId !== null) continue;
    const accepted = clip(factBody(ledger.graph.facts, conflict.acceptedFactId));
    const proposed = clip(factBody(ledger.graph.facts, conflict.proposedFactId));
    const summary = clip(
      `${conflict.authorId} conflicts with accepted memory: ${accepted} / ${proposed}`,
    );
    notices.push(
      decodeStewardNoticeV1({
        noticeId: fitId("steward-conflict", conflict.conflictId),
        projectId: conflict.projectId,
        taskId: conflict.taskId,
        kind: "open_conflict",
        authorId: conflict.authorId,
        summary,
        conflictId: conflict.conflictId,
        attemptId: conflict.attemptId,
        acceptedFactId: conflict.acceptedFactId,
        proposedFactId: conflict.proposedFactId,
      }),
    );
  }
  return notices;
};
