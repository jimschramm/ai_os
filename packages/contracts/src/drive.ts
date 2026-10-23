import * as Schema from "effect/Schema";

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
