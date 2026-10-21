import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { canonicalInstant } from "./canonical.ts";

export const strictParse = { onExcessProperty: "error" as const };

const boundedPattern = (max: number, pattern: RegExp) =>
  Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(pattern));

export const ContractId = boundedPattern(128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type ContractId = typeof ContractId.Type;

const MODEL_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

type ParsedModel = {
  readonly provider?: string;
  readonly model: string;
};

/**
 * Provider is attribution, not part of model identity. `openai/gpt-5.4`,
 * `azure/gpt-5.4`, and a bare `gpt-5.4` are the same model. Characters outside
 * the model alphabet, including zero-width characters, are rejected.
 */
export const parseModelRef = (value: string): ParsedModel | null => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 128 || !/^[a-z0-9][a-z0-9._:/-]*$/.test(trimmed)) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const colon = trimmed.indexOf(":");
  const separatorAt = slash === -1 ? colon : colon === -1 ? slash : Math.min(slash, colon);
  if (separatorAt === -1) {
    return MODEL_SEGMENT.test(trimmed) ? { model: trimmed } : null;
  }
  if (trimmed.includes("/", separatorAt + 1) || trimmed.includes(":", separatorAt + 1)) {
    return null;
  }
  const provider = trimmed.slice(0, separatorAt);
  const model = trimmed.slice(separatorAt + 1);
  if (!MODEL_SEGMENT.test(provider) || !MODEL_SEGMENT.test(model)) {
    return null;
  }
  return { provider, model };
};

export const modelName = (value: ParsedModel | string): string | null => {
  if (typeof value === "string") {
    return parseModelRef(value)?.model ?? null;
  }
  const model = value.model.trim().toLowerCase();
  if (!MODEL_SEGMENT.test(model)) {
    return null;
  }
  if (value.provider !== undefined && !MODEL_SEGMENT.test(value.provider.trim().toLowerCase())) {
    return null;
  }
  return model;
};

export const sameModelName = (left: ParsedModel | string, right: ParsedModel | string): boolean => {
  const leftName = modelName(left);
  const rightName = modelName(right);
  return leftName !== null && leftName === rightName;
};

const CanonicalModelSegment = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value: string) => {
    const canonical = value.trim().toLowerCase();
    return MODEL_SEGMENT.test(canonical) ? true : "Expected a model name.";
  }),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => value.trim().toLowerCase(),
      encode: (value) => value,
    }),
  ),
);

const ModelRefStruct = Schema.Struct({
  provider: Schema.optionalKey(CanonicalModelSegment),
  model: CanonicalModelSegment,
});

const ModelRefFromString = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value: string) =>
    parseModelRef(value) !== null ? true : "Expected a model name, optionally provider/model.",
  ),
).pipe(
  Schema.decodeTo(
    ModelRefStruct,
    SchemaTransformation.transform({
      decode: (value) => parseModelRef(value) ?? { model: value.trim().toLowerCase() },
      encode: (value) =>
        value.provider === undefined ? value.model : `${value.provider}/${value.model}`,
    }),
  ),
);

export const ModelRef = Schema.Union([ModelRefFromString, ModelRefStruct]);
export type ModelRef = typeof ModelRef.Type;

const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const canonicalGitSha = (value: string): string | null => {
  const sha = value.trim().toLowerCase();
  return FULL_GIT_SHA.test(sha) ? sha : null;
};

export const GitSha = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value: string) =>
    canonicalGitSha(value) !== null
      ? true
      : "Expected a full git object id (40 or 64 hex characters).",
  ),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => canonicalGitSha(value) ?? value.trim().toLowerCase(),
      encode: (value) => value,
    }),
  ),
);
export type GitSha = typeof GitSha.Type;

const driveToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value: string) =>
    value.trim() === value && /^\S+$/.test(value) ? true : "Expected a Drive id or version.",
  ),
);

const namedKind = Schema.Literals(["page", "preview", "deployment", "document"]);

export const GitArtifactRevisionV1 = Schema.Struct({
  type: Schema.Literal("git"),
  sha: GitSha,
});
export type GitArtifactRevisionV1 = typeof GitArtifactRevisionV1.Type;

export const DriveArtifactRevisionV1 = Schema.Struct({
  type: Schema.Literal("drive"),
  fileId: driveToken,
  version: driveToken,
});
export type DriveArtifactRevisionV1 = typeof DriveArtifactRevisionV1.Type;

export const NamedArtifactRevisionV1 = Schema.Struct({
  type: Schema.Literal("named"),
  kind: namedKind,
  id: ContractId,
});
export type NamedArtifactRevisionV1 = typeof NamedArtifactRevisionV1.Type;

export const ArtifactRevisionV1 = Schema.Union([
  GitArtifactRevisionV1,
  DriveArtifactRevisionV1,
  NamedArtifactRevisionV1,
]);
export type ArtifactRevisionV1 = typeof ArtifactRevisionV1.Type;

const NAMED_KIND = /^(page|preview|deployment|document)$/;
const NAMED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const canonicalRevisionKey = (revision: ArtifactRevisionV1): string | null => {
  switch (revision.type) {
    case "git": {
      const sha = canonicalGitSha(revision.sha);
      return sha === null ? null : `git:${sha}`;
    }
    case "drive": {
      const fileId = revision.fileId.trim();
      const version = revision.version.trim();
      if (
        fileId.length === 0 ||
        version.length === 0 ||
        fileId.length > 256 ||
        version.length > 256 ||
        !/^\S+$/.test(fileId) ||
        !/^\S+$/.test(version)
      ) {
        return null;
      }
      return `drive:${fileId}:${version}`;
    }
    case "named": {
      const kind = revision.kind.trim().toLowerCase();
      const id = revision.id.trim();
      if (!NAMED_KIND.test(kind) || !NAMED_ID.test(id) || id.length > 128) {
        return null;
      }
      return `named:${kind}:${id}`;
    }
  }
};

export const sameRevision = (left: ArtifactRevisionV1, right: ArtifactRevisionV1): boolean => {
  const canonicalLeft = canonicalRevisionKey(left);
  const canonicalRight = canonicalRevisionKey(right);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
};

export const EvidenceRef = boundedPattern(128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type EvidenceRef = typeof EvidenceRef.Type;

export const ContractText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8_000),
  Schema.makeFilter((value: string) =>
    value.trim() === value && value.length > 0 ? true : "Expected non-blank text.",
  ),
);
export type ContractText = typeof ContractText.Type;

export const IsoDateTime = Schema.String.check(
  Schema.makeFilter((value: string) =>
    canonicalInstant(value) !== null ? true : "Expected an RFC3339 UTC instant.",
  ),
);
export type IsoDateTime = typeof IsoDateTime.Type;

export const taskLinkFor = (taskId: string): string => `ai-os://tasks/${taskId}`;

export const taskLinkMatches = (taskId: string, taskLink: string): boolean =>
  taskLink === taskLinkFor(taskId);

export const TaskLink = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^ai-os:\/\/tasks\/[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
export type TaskLink = typeof TaskLink.Type;

export const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);
export type NonNegativeInt = typeof NonNegativeInt.Type;

export const PositiveInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(1_000_000),
);
export type PositiveInt = typeof PositiveInt.Type;

export const ContractVersion = Schema.Literal("v1");
export type ContractVersion = typeof ContractVersion.Type;
