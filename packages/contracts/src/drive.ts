import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

/**
 * Google Drive file and folder ids are URL-safe base64-ish tokens. Bounded so
 * a pasted value can never grow settings.json without limit.
 */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export const DriveFolderId = Schema.String.check(Schema.isPattern(DRIVE_ID));
export type DriveFolderId = typeof DriveFolderId.Type;

/**
 * Project-only Drive settings. `inputFolderId` is an optional default place to
 * look, not a boundary: ai_os may read anything in the signed-in Drive.
 * `outputFolderId` is the default place for new outputs. Originals are never
 * modified: edits become new `<name>_aios_vN` files next to the original.
 */
export const ProjectDriveSettings = Schema.Struct({
  enabled: Schema.Boolean,
  inputFolderId: Schema.optionalKey(DriveFolderId),
  outputFolderId: Schema.optionalKey(DriveFolderId),
});
export type ProjectDriveSettings = typeof ProjectDriveSettings.Type;

const FOLDER_PATH = /\/folders\/([A-Za-z0-9_-]+)/;

/**
 * Accepts a pasted Drive folder link (any `.../folders/<id>` form, with or
 * without `/u/<n>/`, query or fragment), an `open?id=<id>` link, or a bare id.
 * Returns null for anything else, including file (`/file/d/`) and Docs links.
 */
export const parseDriveFolderId = (input: string): string | null => {
  const value = input.trim();
  if (value.length === 0) return null;
  if (DRIVE_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "drive.google.com") return null;
  const fromPath = FOLDER_PATH.exec(url.pathname)?.[1];
  const candidate = fromPath ?? (url.pathname === "/open" ? url.searchParams.get("id") : null);
  return candidate !== null && candidate !== undefined && DRIVE_ID.test(candidate)
    ? candidate
    : null;
};

/**
 * A `drive project` change, sent to the running server (or applied offline).
 * Links are parsed where the change is applied, so a stale CLI never writes
 * an unchecked id.
 */
export const ProjectDriveUpdate = Schema.Struct({
  projectId: ProjectId,
  output: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  clearInput: Schema.Boolean,
  clearOutput: Schema.Boolean,
  disable: Schema.Boolean,
});
export type ProjectDriveUpdate = typeof ProjectDriveUpdate.Type;

export interface ResolvedProjectDriveUpdate {
  readonly outputFolderId?: string;
  readonly inputFolderId?: string;
  readonly clearInput: boolean;
  readonly clearOutput: boolean;
  readonly disable: boolean;
}

/** Parses the pasted links. Pure and independent of stored settings. */
export const resolveProjectDriveUpdate = (
  update: Omit<ProjectDriveUpdate, "projectId">,
): ResolvedProjectDriveUpdate | { readonly invalidLink: string } => {
  const resolved: {
    -readonly [K in keyof ResolvedProjectDriveUpdate]: ResolvedProjectDriveUpdate[K];
  } = { clearInput: update.clearInput, clearOutput: update.clearOutput, disable: update.disable };
  for (const [key, raw] of [
    ["outputFolderId", update.output],
    ["inputFolderId", update.input],
  ] as const) {
    if (raw === undefined) continue;
    const id = parseDriveFolderId(raw);
    if (id === null) return { invalidLink: raw };
    resolved[key] = id;
  }
  return resolved;
};

/** Applies a resolved change to the current setting. Total: never fails. */
export const applyProjectDriveUpdate = (
  current: ProjectDriveSettings | undefined,
  update: ResolvedProjectDriveUpdate,
): ProjectDriveSettings => {
  const next: { -readonly [K in keyof ProjectDriveSettings]: ProjectDriveSettings[K] } = {
    ...current,
    enabled: !update.disable,
  };
  if (update.outputFolderId !== undefined) next.outputFolderId = update.outputFolderId;
  if (update.inputFolderId !== undefined) next.inputFolderId = update.inputFolderId;
  if (update.clearInput) delete next.inputFolderId;
  if (update.clearOutput) delete next.outputFolderId;
  return next;
};
