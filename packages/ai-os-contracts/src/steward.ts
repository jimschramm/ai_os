import * as Schema from "effect/Schema";

import { ContractId, ContractText, strictParse } from "./common.ts";
import type { MemoryFactV1 } from "./memory.ts";
import type { MemoryLedgerV1 } from "./submission.ts";
import type { AttemptMemoryActivityV1 } from "./taskMemory.ts";

export const StewardNoticeKindV1 = Schema.Literals([
  "open_conflict",
  "missing_write",
  "needs_worker",
]);
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

const factAcceptance = (facts: readonly MemoryFactV1[], factId: string): string | undefined =>
  facts.find((fact) => fact.factId === factId)?.acceptance;

/**
 * The side named acceptedFactId is the earlier statement. It is accepted
 * knowledge only when that fact was accepted. Two proposals are not that.
 */
const conflictSummary = (
  authorId: string,
  facts: readonly MemoryFactV1[],
  acceptedFactId: string,
  proposedFactId: string,
): string => {
  const accepted = clip(factBody(facts, acceptedFactId));
  const proposed = clip(factBody(facts, proposedFactId));
  const left = factAcceptance(facts, acceptedFactId);
  const right = factAcceptance(facts, proposedFactId);
  const relation =
    left === "accepted" || right === "accepted"
      ? "conflicts with accepted memory"
      : "conflicts with a proposal";
  return clip(`${authorId} ${relation}: ${accepted} / ${proposed}`);
};

/**
 * Open conflicts, and ended attempts that read memory without writing.
 * `inFlightAttemptIds` is the card's active assignment. A running attempt has
 * not finished, so a missing write is not a blocker yet.
 * A proposal, including an explicit no-change explanation, counts as a write.
 */
export const reviewSteward = (
  ledger: MemoryLedgerV1,
  activity: readonly AttemptMemoryActivityV1[],
  inFlightAttemptIds: ReadonlySet<string> = new Set(),
): readonly StewardNoticeV1[] => {
  const notices: StewardNoticeV1[] = [];
  for (const item of activity) {
    if (item.write !== null || inFlightAttemptIds.has(item.attemptId)) continue;
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
  const seenConflicts = new Set<string>();
  for (const conflict of ledger.conflicts) {
    if (conflict.resolvedBySubmissionId !== null || seenConflicts.has(conflict.conflictId)) {
      continue;
    }
    seenConflicts.add(conflict.conflictId);
    const summary = conflictSummary(
      conflict.authorId,
      ledger.graph.facts,
      conflict.acceptedFactId,
      conflict.proposedFactId,
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

/** The card stays put. The existing Needs you list is what asks Jim. */
export const needsWorkerNotice = (projectId: string, taskId: string): StewardNoticeV1 =>
  decodeStewardNoticeV1({
    noticeId: fitId("needs-worker", taskId),
    projectId,
    taskId,
    kind: "needs_worker",
    authorId: "ai-os",
    summary: clip(
      `Ask Jim to choose an implementer for ${projectId}. No eligible worker is configured.`,
    ),
    conflictId: null,
    attemptId: null,
    acceptedFactId: null,
    proposedFactId: null,
  });
