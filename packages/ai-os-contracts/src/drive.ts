import * as Schema from "effect/Schema";

import { ContractText, strictParse } from "./common.ts";

/** Where a Drive snapshot lives inside the project worktree. */
export const DRIVE_SNAPSHOT_DIR = ".ai_os/drive";

const RelativePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value: string) =>
    !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..")
      ? true
      : "Expected a relative path inside the worktree.",
  ),
);

/** No size caps: byte totals can exceed the generic contract integer bound. */
const ByteCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Count = ByteCount;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** One Drive file in a task snapshot. Paths are relative to the worktree. */
export const DriveManifestFileV1 = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  /** Path inside the picked folder, or the name for a single file. */
  drivePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  kind: Schema.Literals(["text", "image", "file", "link"]),
  bytes: ByteCount,
  original: Schema.optionalKey(RelativePath),
  text: Schema.optionalKey(RelativePath),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
});
export type DriveManifestFileV1 = typeof DriveManifestFileV1.Type;

/**
 * The Drive part of a context package: which files were copied in for this
 * task. The full manifest (with Drive links and content hashes) is
 * `<root>/manifest.json`; `manifestSha256` pins it so a resume can tell a
 * missing or changed snapshot.
 */
export const DriveManifestRefV1 = Schema.Struct({
  root: RelativePath,
  manifestSha256: Sha256,
  totalFiles: Count,
  totalBytes: ByteCount,
  failedFiles: Count,
  files: Schema.Array(DriveManifestFileV1),
  sources: Schema.Array(ContractText),
});
export type DriveManifestRefV1 = typeof DriveManifestRefV1.Type;

export const decodeDriveManifestRefV1 = Schema.decodeUnknownEffect(DriveManifestRefV1, strictParse);

/** "12 files, 3.4 MB" for cards and prompts. */
export const describeDriveSize = (totalFiles: number, totalBytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = totalBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const size = unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
  return `${totalFiles} ${totalFiles === 1 ? "file" : "files"}, ${size}`;
};
