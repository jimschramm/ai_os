import * as Schema from "effect/Schema";

import { PartialArtifactV1 } from "./progress.ts";
import { EvidenceV1 } from "./completion.ts";
import {
  ContractId,
  ContractText,
  ContractVersion,
  GitSha,
  ModelRef,
  PositiveInt,
  canonicalGitSha,
  strictParse,
} from "./common.ts";

const FindingPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value: string) =>
    value.trim() === value && !/[\r\n]/.test(value) ? true : "Expected a file path.",
  ),
);

export const AdvisoryFindingV1 = Schema.Struct({
  commit: GitSha,
  files: Schema.NonEmptyArray(FindingPath),
  evidence: ContractText,
  suggestedAction: ContractText,
});
export type AdvisoryFindingV1 = typeof AdvisoryFindingV1.Type;

export const AdvisoryModelChoiceV1 = Schema.Struct({
  requested: ModelRef,
  // Null when the CLI result did not name the model that ran.
  actual: Schema.NullOr(ModelRef),
  // True when `agy models` failed and the choice was typed or configured.
  unverified: Schema.Boolean,
});
export type AdvisoryModelChoiceV1 = typeof AdvisoryModelChoiceV1.Type;

const boundToCommit = Schema.makeFilter(
  (review: {
    readonly commit: string;
    readonly findings: readonly { readonly commit: string }[];
  }) => {
    for (const finding of review.findings) {
      if (canonicalGitSha(finding.commit) !== canonicalGitSha(review.commit)) {
        return "Each finding is bound to the reviewed commit.";
      }
    }
    return true;
  },
);

/**
 * An advisory repository review. It is not a QA verdict and does not accept work.
 */
export const AdvisoryReviewV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  generation: PositiveInt,
  leaseId: ContractId,
  mode: Schema.Literal("advisory"),
  commit: GitSha,
  model: AdvisoryModelChoiceV1,
  findings: Schema.Array(AdvisoryFindingV1),
  artifacts: Schema.Array(PartialArtifactV1),
  evidence: Schema.Array(EvidenceV1),
  sourcePath: ContractText,
  scratchPath: ContractText,
}).check(boundToCommit);
export type AdvisoryReviewV1 = typeof AdvisoryReviewV1.Type;

export const decodeAdvisoryReviewV1 = Schema.decodeUnknownEffect(AdvisoryReviewV1, strictParse);
