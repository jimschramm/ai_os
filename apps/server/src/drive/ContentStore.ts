// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node module so the RFP app and memory indexing can reuse it.
/**
 * Local store for Drive content, under `<stateDir>/drive-content/`.
 *
 *   <fileId>/<version>/original<.ext>   bytes as downloaded or exported
 *   <fileId>/<version>/text.txt         extracted text, when there is any
 *   <fileId>/<version>/meta.json        DriveContentMeta
 *   index.jsonl                         one DriveContentMeta per stored version
 *
 * `version` comes from Drive's modifiedTime (+ md5 when Drive has one), so an
 * unchanged file is never downloaded twice and an edited one gets a new entry.
 * Each entry records the sha256 of the stored original. Entries are written to
 * a temp dir and renamed, so a crash never leaves half an entry.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExtractKind } from "./extract.ts";

/** Folder name under the server state dir. */
export const DRIVE_CONTENT_DIR = "drive-content";

export interface DriveContentMeta {
  readonly fileId: string;
  readonly version: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string | null;
  readonly md5Checksum: string | null;
  readonly webViewLink: string | null;
  /** "link" when Drive offers no bytes (e.g. Forms); nothing is stored then. */
  readonly kind: ExtractKind | "link";
  readonly method: string;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly originalFile: string | null;
  readonly textFile: string | null;
  readonly textChars: number;
  readonly error: string | null;
  readonly storedAt: string;
}

export interface StoredContent {
  readonly meta: DriveContentMeta;
  /** Absolute paths inside the store. */
  readonly originalPath: string | null;
  readonly textPath: string | null;
}

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);

export const contentVersion = (modifiedTime: string | null, md5: string | null) =>
  safeSegment(`${modifiedTime ?? "unknown"}${md5 === null ? "" : `-${md5.slice(0, 12)}`}`);

export const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export const makeContentStore = (root: string) => {
  const entryDir = (fileId: string, version: string) =>
    path.join(root, safeSegment(fileId), version);

  const toStored = (dir: string, meta: DriveContentMeta): StoredContent => ({
    meta,
    originalPath: meta.originalFile === null ? null : path.join(dir, meta.originalFile),
    textPath: meta.textFile === null ? null : path.join(dir, meta.textFile),
  });

  const get = async (fileId: string, version: string): Promise<StoredContent | null> => {
    const dir = entryDir(fileId, version);
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(dir, "meta.json"), "utf8"),
      ) as DriveContentMeta;
      // A stored original whose bytes no longer match is treated as missing.
      if (meta.originalFile !== null && meta.sha256 !== null) {
        const bytes = await fs.readFile(path.join(dir, meta.originalFile));
        if (sha256Hex(bytes) !== meta.sha256) return null;
      }
      return toStored(dir, meta);
    } catch {
      return null;
    }
  };

  const put = async (input: {
    readonly fileId: string;
    readonly version: string;
    readonly name: string;
    readonly mimeType: string;
    readonly modifiedTime: string | null;
    readonly md5Checksum: string | null;
    readonly webViewLink: string | null;
    readonly kind: ExtractKind | "link";
    readonly method: string;
    readonly original: Uint8Array | null;
    readonly originalExt: string;
    readonly text: string | null;
    readonly error: string | null;
  }): Promise<StoredContent> => {
    const dir = entryDir(input.fileId, input.version);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const temporary = `${dir}.${randomUUID()}.tmp`;
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
      const originalFile =
        input.original === null
          ? null
          : `original${input.originalExt === "" ? "" : `.${safeSegment(input.originalExt)}`}`;
      if (input.original !== null && originalFile !== null) {
        await fs.writeFile(path.join(temporary, originalFile), input.original, { mode: 0o600 });
      }
      const textFile = input.text === null ? null : "text.txt";
      if (input.text !== null) {
        await fs.writeFile(path.join(temporary, "text.txt"), input.text, { mode: 0o600 });
      }
      const meta: DriveContentMeta = {
        fileId: input.fileId,
        version: input.version,
        name: input.name,
        mimeType: input.mimeType,
        modifiedTime: input.modifiedTime,
        md5Checksum: input.md5Checksum,
        webViewLink: input.webViewLink,
        kind: input.kind,
        method: input.method,
        bytes: input.original?.byteLength ?? 0,
        sha256: input.original === null ? null : sha256Hex(input.original),
        originalFile,
        textFile,
        textChars: input.text?.length ?? 0,
        error: input.error,
        storedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(temporary, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, {
        mode: 0o600,
      });
      const published = await fs.rename(temporary, dir).then(
        () => true,
        () => false,
      );
      if (!published) {
        // Another task stored this version first: use its entry when it checks out.
        const existing = await get(input.fileId, input.version);
        if (existing !== null) {
          await fs.rm(temporary, { recursive: true, force: true });
          return existing;
        }
        // A stale entry (failed sha check): move it aside, then publish the fresh one.
        const stale = `${dir}.${randomUUID()}.stale`;
        await fs.rename(dir, stale).catch(() => undefined);
        const replaced = await fs.rename(temporary, dir).then(
          () => true,
          () => false,
        );
        await fs.rm(stale, { recursive: true, force: true });
        if (!replaced) {
          // A parallel repair published first: use its entry when it checks out.
          const winner = await get(input.fileId, input.version);
          await fs.rm(temporary, { recursive: true, force: true });
          if (winner !== null) return winner;
          throw new Error(`Could not store ${input.fileId} version ${input.version}.`);
        }
      }
      await fs.appendFile(path.join(root, "index.jsonl"), `${JSON.stringify(meta)}\n`, {
        mode: 0o600,
      });
      return toStored(dir, meta);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  /** Every stored version, newest line last; for memory and retrieval indexing. */
  const list = async (): Promise<DriveContentMeta[]> => {
    const text = await fs.readFile(path.join(root, "index.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as DriveContentMeta];
        } catch {
          return [];
        }
      });
  };

  return { root, get, put, list };
};

export type ContentStore = ReturnType<typeof makeContentStore>;
