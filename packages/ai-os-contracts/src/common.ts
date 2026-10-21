import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const strictParse = { onExcessProperty: "error" as const };

const boundedPattern = (max: number, pattern: RegExp) =>
  Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(pattern));

export const ContractId = boundedPattern(128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type ContractId = typeof ContractId.Type;

const MODEL_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Provider prefixes are part of the identity after the separator is normalized.
 * `gpt-5.4` and `openai/gpt-5.4` stay different. `OpenAI:GPT-5.4` and
 * `openai/gpt-5.4` are the same model.
 */
export const canonicalModelId = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const colon = trimmed.indexOf(":");
  const separatorAt = slash === -1 ? colon : colon === -1 ? slash : Math.min(slash, colon);
  if (separatorAt === -1) {
    return MODEL_SEGMENT.test(trimmed) ? trimmed : null;
  }
  if (trimmed.includes("/", separatorAt + 1) || trimmed.includes(":", separatorAt + 1)) {
    return null;
  }
  const provider = trimmed.slice(0, separatorAt);
  const model = trimmed.slice(separatorAt + 1);
  if (!MODEL_SEGMENT.test(provider) || !MODEL_SEGMENT.test(model)) {
    return null;
  }
  return `${provider}/${model}`;
};

export const sameModel = (left: string, right: string): boolean => {
  const canonicalLeft = canonicalModelId(left);
  const canonicalRight = canonicalModelId(right);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
};

const isCanonicalModel = Schema.makeFilter((value: string) =>
  canonicalModelId(value) !== null ? true : "Expected a model id, optionally provider/model.",
);

export const ModelId = Schema.String.check(Schema.isMaxLength(128), isCanonicalModel).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => canonicalModelId(value) ?? value.trim().toLowerCase(),
      encode: (value) => value,
    }),
  ),
);
export type ModelId = typeof ModelId.Type;

const GIT_SHA = /^[0-9a-f]{7,64}$/;
const GIT_SHA_INPUT = /^[0-9a-fA-F]{7,64}$/;

export const canonicalGitSha = (value: string): string | null => {
  const sha = value.trim().toLowerCase();
  return GIT_SHA.test(sha) && GIT_SHA_INPUT.test(value.trim()) ? sha : null;
};

export const GitSha = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value: string) =>
    canonicalGitSha(value) !== null ? true : "Expected a git SHA.",
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
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
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

export const ContractVersion = Schema.Literal("v1");
export type ContractVersion = typeof ContractVersion.Type;
