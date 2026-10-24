import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ContractText, GitSha, PositiveInt } from "./common.ts";
import { QaFindingV1 } from "./qa.ts";

/**
 * Rework rounds belong to the task, not the attempt or the run.
 * A new attempt id, a new generation, a handoff, a retry, and a reload
 * all keep this ledger. No event clears it.
 */
export const REWORK_CAP = 3;
export const REWORK_CAP_LABEL = "Needs Jim: rework cap reached";
export const JIM_ACTOR_ID = "jim";

export const ReworkRoundV1 = Schema.Struct({
  round: PositiveInt,
  summary: ContractText,
  commitSha: Schema.NullOr(GitSha),
  findings: Schema.NonEmptyArray(QaFindingV1),
});
export type ReworkRoundV1 = typeof ReworkRoundV1.Type;

export const JimResumeDecisionV1 = Schema.Struct({
  actorId: Schema.Literal(JIM_ACTOR_ID),
  decision: ContractText,
  reworkRounds: PositiveInt,
});
export type JimResumeDecisionV1 = typeof JimResumeDecisionV1.Type;

export const ReworkLedgerV1 = Schema.Struct({
  rounds: Schema.Array(ReworkRoundV1),
  decisions: Schema.Array(JimResumeDecisionV1),
})
  .check(
    Schema.makeFilter((ledger) => {
      for (let index = 0; index < ledger.rounds.length; index += 1) {
        if (ledger.rounds[index]?.round !== index + 1) {
          return "Rework rounds are numbered on the task, starting at 1.";
        }
      }
      return true;
    }),
  )
  .pipe(Schema.withDecodingDefault(Effect.sync(() => ({ rounds: [], decisions: [] }))));
export type ReworkLedgerV1 = typeof ReworkLedgerV1.Type;

export const ReworkCapNoticeV1 = Schema.Struct({
  label: Schema.Literal(REWORK_CAP_LABEL),
  remainingIssue: Schema.NonEmptyArray(QaFindingV1),
  attemptedFixes: Schema.NonEmptyArray(ReworkRoundV1),
  recommendation: ContractText,
});
export type ReworkCapNoticeV1 = typeof ReworkCapNoticeV1.Type;

const sameFindings = (left: readonly QaFindingV1[], right: readonly QaFindingV1[]): boolean =>
  left.length === right.length &&
  left.every(
    (finding, index) =>
      finding.defect === right[index]?.defect &&
      finding.evidence === right[index]?.evidence &&
      finding.expectedBehavior === right[index]?.expectedBehavior,
  );

const sameRound = (left: ReworkRoundV1, right: ReworkRoundV1): boolean =>
  left.round === right.round &&
  left.summary === right.summary &&
  left.commitSha === right.commitSha &&
  sameFindings(left.findings, right.findings);

/** Work may continue only when Jim has resumed at the current count. */
export const reworkCapAllowsWork = (ledger: ReworkLedgerV1): true | string => {
  if (ledger.rounds.length < REWORK_CAP) return true;
  return ledger.decisions.some((decision) => decision.reworkRounds === ledger.rounds.length)
    ? true
    : "The rework cap holds until Jim resumes.";
};

export const reworkCapNoticeMatches = (input: {
  readonly ledger: ReworkLedgerV1;
  readonly notice: ReworkCapNoticeV1;
  readonly recommendation: string | undefined;
}): true | string => {
  if (input.ledger.rounds.length < REWORK_CAP) {
    return "The rework cap is reached only after three rounds.";
  }
  const latest = input.ledger.rounds.at(-1);
  if (latest === undefined || input.notice.attemptedFixes.length !== input.ledger.rounds.length) {
    return "The notice lists every rework round.";
  }
  for (let index = 0; index < input.ledger.rounds.length; index += 1) {
    const round = input.ledger.rounds[index];
    const listed = input.notice.attemptedFixes[index];
    if (round === undefined || listed === undefined || !sameRound(round, listed)) {
      return "The notice lists every rework round.";
    }
  }
  if (!sameFindings(input.notice.remainingIssue, latest.findings)) {
    return "The notice keeps the latest QA findings.";
  }
  if (input.recommendation !== input.notice.recommendation) {
    return "The notice keeps the recommendation from the latest rework.";
  }
  return true;
};
