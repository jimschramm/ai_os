// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node module so the RFP app can reuse it; callers wrap it in Effect.tryPromise.
/**
 * Reads Drive files into the content store and copies a task's files into the
 * project worktree. Never writes to Drive.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DRIVE_SNAPSHOT_DIR,
  type DriveManifestFileV1,
  type DriveManifestRefV1,
} from "@t3tools/ai-os-contracts";

import {
  type ContentStore,
  contentVersion,
  sha256Hex,
  type StoredContent,
} from "./ContentStore.ts";
import {
  type DriveApi,
  type DriveFile,
  type DriveListedFile,
  DriveApiError,
  type ListRecursiveOptions,
  FOLDER_MIME,
  parseDriveRef,
} from "./DriveApi.ts";
import { extensionOf, extractContent, extractXlsx } from "./extract.ts";

const GOOGLE = "application/vnd.google-apps.";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Downloads (or exports) one file and extracts its text, reusing the stored
 * copy when Drive reports the same version. Never throws for a bad file: the
 * error is recorded on the entry.
 */
export const readDriveFile = async (
  api: DriveApi,
  store: ContentStore,
  file: DriveFile,
  options: { readonly pdfTimeoutMs?: number } = {},
): Promise<StoredContent> => {
  const version = contentVersion(file.modifiedTime ?? null, file.md5Checksum ?? null);
  const existing = await store.get(file.id, version);
  if (existing !== null) return existing;
  const base = {
    fileId: file.id,
    version,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime ?? null,
    md5Checksum: file.md5Checksum ?? null,
    webViewLink: file.webViewLink ?? null,
  };
  const changed = () =>
    new DriveApiError(`${file.name} changed in Drive while it was read; run it again.`);
  /** Exports carry no checksum: the file's version must be the same after reading it. */
  const unchanged = async () => {
    const after = await api.getFile(file.id);
    if (
      (after.modifiedTime ?? null) !== (file.modifiedTime ?? null) ||
      (after.md5Checksum ?? null) !== (file.md5Checksum ?? null)
    ) {
      throw changed();
    }
  };
  try {
    if (file.mimeType.startsWith(GOOGLE)) {
      const kind = file.mimeType.slice(GOOGLE.length);
      if (kind === "document" || kind === "presentation") {
        const original = await api.exportAs(file.id, kind === "document" ? DOCX : PPTX);
        const text = decode(await api.exportAs(file.id, "text/plain"));
        await unchanged();
        return await store.put({
          ...base,
          kind: "text",
          method: `google-${kind}`,
          original,
          originalExt: kind === "document" ? "docx" : "pptx",
          text,
          error: null,
        });
      }
      if (kind === "spreadsheet") {
        const original = await api.exportAs(file.id, XLSX);
        await unchanged();
        let text: string | null = null;
        let error: string | null = null;
        try {
          text = await extractXlsx(original);
        } catch (cause) {
          error = (cause as Error).message.slice(0, 300);
        }
        return await store.put({
          ...base,
          kind: text === null ? "file" : "text",
          method: "google-spreadsheet",
          original,
          originalExt: "xlsx",
          text,
          error,
        });
      }
      if (kind === "drawing") {
        const original = await api.exportAs(file.id, "image/png");
        await unchanged();
        return await store.put({
          ...base,
          kind: "image",
          method: "google-drawing",
          original,
          originalExt: "png",
          text: null,
          error: null,
        });
      }
      // Forms, Sites, Maps and the like have no downloadable content.
      return await store.put({
        ...base,
        kind: "link",
        method: `google-${kind}`,
        original: null,
        originalExt: "",
        text: null,
        error: "Google offers no download for this file type; open it from its Drive link.",
      });
    }
    const original = await api.download(file.id);
    // The bytes must be the version they are stored under.
    if (file.md5Checksum != null) {
      if (createHash("md5").update(original).digest("hex") !== file.md5Checksum) throw changed();
    } else {
      await unchanged();
    }
    const extracted = await extractContent({
      name: file.name,
      mimeType: file.mimeType,
      bytes: original,
      ...(options.pdfTimeoutMs === undefined ? {} : { pdfTimeoutMs: options.pdfTimeoutMs }),
    });
    return await store.put({
      ...base,
      kind: extracted.kind,
      method: extracted.method,
      original,
      originalExt: extensionOf(file.name),
      text: extracted.text ?? null,
      error: extracted.error ?? null,
    });
  } catch (cause) {
    if (cause instanceof DriveApiError && cause.status === 401) throw cause;
    if (cause instanceof Error && cause.message.startsWith("Drive login needed")) throw cause;
    // Not stored: a network or export failure should be retried next time.
    return {
      meta: {
        ...base,
        kind: "file",
        method: "none",
        bytes: 0,
        sha256: null,
        originalFile: null,
        textFile: null,
        textChars: 0,
        error: (cause as Error).message.slice(0, 300),
        storedAt: new Date().toISOString(),
      },
      originalPath: null,
      textPath: null,
    };
  }
};

export interface ResolvedRef {
  readonly ref: string;
  readonly root: DriveFile;
  readonly files: DriveListedFile[];
}

/** A link or id → the file, or every file under the folder (recursive). */
export const resolveRef = async (
  api: DriveApi,
  ref: string,
  options?: ListRecursiveOptions,
): Promise<ResolvedRef> => {
  const id = parseDriveRef(ref);
  if (id === null) throw new DriveApiError(`Not a Google Drive link or id: ${ref}`);
  const root = await api.resolve(await api.getFile(id));
  if (root.mimeType === FOLDER_MIME) {
    return { ref, root, files: await api.listRecursive(root.id, options) };
  }
  return { ref, root, files: [{ ...root, path: root.name }] };
};

const utf8 = new TextEncoder();

const byteLength = (value: string) => utf8.encode(value).length;

/** The longest prefix of `value` that fits in `max` UTF-8 bytes, whole characters only. */
const cutBytes = (value: string, max: number) => {
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (bytes + size > max) break;
    out += char;
    bytes += size;
  }
  return out;
};

/** File systems allow 255 bytes per name. */
const NAME_BYTES = 255;
const TEXT_SUFFIX = ".text.txt";

/**
 * File names for one snapshot entry, each within NAME_BYTES: the `0001-`
 * prefix, the cleaned Drive name, and the original's extension or the text
 * suffix. A very long extension is cut to 32 bytes.
 */
const entryNames = (index: number, driveName: string, originalExt: string) => {
  const prefix = `${String(index).padStart(4, "0")}-`;
  const ext = cutBytes(originalExt.replace(/[^\p{L}\p{N}.]+/gu, "_"), 32);
  const budget =
    NAME_BYTES - byteLength(prefix) - Math.max(byteLength(ext), byteLength(TEXT_SUFFIX));
  const cleaned = driveName
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim();
  const stem = `${prefix}${cutBytes(cleaned, budget) || "file"}`;
  return {
    original: stem.toLowerCase().endsWith(ext.toLowerCase()) ? stem : `${stem}${ext}`,
    text: `${stem}${TEXT_SUFFIX}`,
  };
};

/**
 * The snapshot folder for a task: "_" and ":" escaped so no two ids share one.
 * A long escaped id is cut and given a hash of the full id ("_h" never comes
 * out of the escaping), so the folder and its `~<uuid>` temp twin stay short.
 */
export const snapshotDirName = (taskId: string) => {
  const escaped = taskId.replaceAll("_", "_5f").replaceAll(":", "_3a");
  return escaped.length <= 160
    ? escaped
    : `${escaped.slice(0, 120)}_h${sha256Hex(taskId).slice(0, 32)}`;
};

export interface SnapshotResult {
  readonly ref: DriveManifestRefV1;
  readonly manifestPath: string;
}

/**
 * Copies every file from `refs` into `<worktree>/.ai_os/drive/<taskId>/` and
 * writes manifest.json there. Copies are read-only (0444). Files picked twice
 * are copied once. No size cap; the totals are reported.
 */
export const buildSnapshot = async (input: {
  readonly api: DriveApi;
  readonly store: ContentStore;
  readonly worktree: string;
  readonly taskId: string;
  readonly refs: readonly string[];
  readonly pdfTimeoutMs?: number;
  readonly now?: () => Date;
  /** Resuming after a restart: return the finished snapshot if it is already there. */
  readonly resume?: boolean;
  /**
   * On resume, the manifest hash the job pinned before publishing. A finished
   * snapshot is reused only if its manifest still has this hash.
   */
  readonly expectedManifestSha256?: string;
  /** Called (and awaited) with the manifest hash just before the snapshot is published. */
  readonly onPublish?: (manifestSha256: string) => Promise<void>;
  /** Which shortcut targets inside attached folders to read; the rest are skipped. */
  readonly followShortcut?: (target: DriveFile) => Promise<boolean>;
  /** Called after each file with (done, total, Drive path). */
  readonly onProgress?: (done: number, total: number, drivePath: string) => void;
}): Promise<SnapshotResult> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.taskId)) {
    throw new DriveApiError(`Invalid task id: ${input.taskId}`);
  }
  // One folder per task id, never shared.
  const relRoot = `${DRIVE_SNAPSHOT_DIR}/${snapshotDirName(input.taskId)}`;
  const absRoot = path.join(input.worktree, ...relRoot.split("/"));
  await assertNoSymlinks(input.worktree, relRoot);
  // A snapshot is immutable: never overwrite one a task already points at.
  if (
    await fs.stat(absRoot).then(
      () => true,
      () => false,
    )
  ) {
    // A resumed job whose snapshot finished before the restart: reuse it as is.
    if (input.resume === true) {
      // Only if it is this job's own snapshot and every copy is intact.
      const existing = await loadSnapshot(input.worktree, relRoot);
      if (
        existing !== null &&
        input.expectedManifestSha256 !== undefined &&
        existing.result.ref.manifestSha256 === input.expectedManifestSha256 &&
        existing.taskId === input.taskId &&
        JSON.stringify(existing.result.ref.sources) ===
          JSON.stringify(input.refs.map((ref) => ref.trim())) &&
        (await verifySnapshot(input.worktree, existing.result.ref)) === null
      ) {
        return existing.result;
      }
    }
    throw new DriveApiError(`A Drive snapshot already exists at ${relRoot}.`);
  }
  // Work in progress lives in .tmp/, which no task folder can be named (task
  // folders start with a letter or digit), as "<task folder>~<uuid>".
  const tmpDir = path.join(input.worktree, ...DRIVE_SNAPSHOT_DIR.split("/"), ".tmp");
  await assertNoSymlinks(input.worktree, `${DRIVE_SNAPSHOT_DIR}/.tmp`);
  // Resuming after a restart: clear what this task's interrupted run left behind.
  // The server runs one job per task, so no live job owns these folders.
  if (input.resume === true) {
    for (const entry of await fs.readdir(tmpDir).catch(() => [] as string[])) {
      if (entry.startsWith(`${path.basename(absRoot)}~`)) {
        await fs.rm(path.join(tmpDir, entry), { recursive: true, force: true });
      }
    }
  }
  const skippedShortcuts: Array<{ path: string; id: string; name: string }> = [];
  const listOptions: ListRecursiveOptions =
    input.followShortcut === undefined
      ? {}
      : {
          followShortcut: input.followShortcut,
          skipped: (target) =>
            skippedShortcuts.push({ path: target.path, id: target.id, name: target.name }),
        };
  const resolved: ResolvedRef[] = [];
  for (const ref of input.refs) resolved.push(await resolveRef(input.api, ref, listOptions));

  await ensureIgnored(input.worktree);
  const temporary = path.join(tmpDir, `${path.basename(absRoot)}~${randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  await assertNoSymlinks(input.worktree, `${DRIVE_SNAPSHOT_DIR}/.tmp`);
  await assertNoSymlinks(input.worktree, relRoot);
  await fs.mkdir(temporary);
  const seen = new Set<string>();
  const files: DriveManifestFileV1[] = [];
  const full: Array<Record<string, unknown>> = [];
  let index = 0;
  const total = new Set(resolved.flatMap((source) => source.files.map((file) => file.id))).size;
  try {
    for (const source of resolved) {
      const prefix = source.root.mimeType === FOLDER_MIME ? `${source.root.name}/` : "";
      for (const file of source.files) {
        if (seen.has(file.id)) continue;
        seen.add(file.id);
        index += 1;
        const stored = await readDriveFile(input.api, input.store, file, {
          ...(input.pdfTimeoutMs === undefined ? {} : { pdfTimeoutMs: input.pdfTimeoutMs }),
        });
        const names = entryNames(
          index,
          file.name,
          stored.originalPath === null ? "" : path.extname(stored.originalPath),
        );
        let original: string | undefined;
        let text: string | undefined;
        const hashes: Record<string, string> = {};
        if (stored.originalPath !== null) {
          const target = names.original;
          await fs.copyFile(stored.originalPath, path.join(temporary, target));
          await fs.chmod(path.join(temporary, target), 0o444);
          original = `${relRoot}/${target}`;
          hashes.originalSha256 = await fileSha(path.join(temporary, target));
        }
        if (stored.textPath !== null) {
          // Its own suffix, so it never meets an original named *.txt.
          const target = names.text;
          await fs.copyFile(stored.textPath, path.join(temporary, target));
          await fs.chmod(path.join(temporary, target), 0o444);
          text = `${relRoot}/${target}`;
          hashes.textSha256 = await fileSha(path.join(temporary, target));
        }
        const entry: DriveManifestFileV1 = {
          id: file.id,
          name: file.name,
          drivePath: `${prefix}${file.path}`,
          kind: stored.meta.kind,
          bytes: stored.meta.bytes,
          ...(original === undefined ? {} : { original }),
          ...(text === undefined ? {} : { text }),
          ...(stored.meta.error === null ? {} : { error: stored.meta.error.slice(0, 400) }),
        };
        files.push(entry);
        input.onProgress?.(index, total, entry.drivePath);
        full.push({
          ...entry,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime ?? null,
          webViewLink: file.webViewLink ?? null,
          sha256: stored.meta.sha256,
          method: stored.meta.method,
          contentStore: `${stored.meta.fileId}/${stored.meta.version}`,
          ...hashes,
        });
      }
    }
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const failedFiles = files.filter((file) => file.error !== undefined).length;
    const manifest = {
      version: 1,
      taskId: input.taskId,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      readOnly: true,
      sources: resolved.map((source) => ({
        ref: source.ref,
        id: source.root.id,
        name: source.root.name,
        folder: source.root.mimeType === FOLDER_MIME,
        webViewLink: source.root.webViewLink ?? null,
      })),
      totalFiles: files.length,
      totalBytes,
      failedFiles,
      files: full,
      // Shortcuts to files outside the project and the attached folders: not read.
      skippedShortcuts,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(temporary, "manifest.json"), manifestText, { mode: 0o444 });
    await input.onPublish?.(sha256Hex(manifestText));
    await fs.rename(temporary, absRoot);
    return {
      manifestPath: path.join(absRoot, "manifest.json"),
      ref: {
        root: relRoot,
        manifestSha256: sha256Hex(manifestText),
        totalFiles: files.length,
        totalBytes,
        failedFiles,
        files,
        sources: resolved.map((source) => source.ref.trim()),
      },
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

/** The reference for a finished snapshot, read back from its manifest. */
const loadSnapshot = async (
  worktree: string,
  relRoot: string,
): Promise<{ taskId: unknown; result: SnapshotResult } | null> => {
  const manifestPath = path.join(worktree, ...relRoot.split("/"), "manifest.json");
  const text = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const manifest = JSON.parse(text) as {
      taskId: unknown;
      totalFiles: number;
      totalBytes: number;
      failedFiles: number;
      sources: Array<{ ref: string }>;
      files: Array<DriveManifestFileV1>;
    };
    const result: SnapshotResult = {
      manifestPath,
      ref: {
        root: relRoot,
        manifestSha256: sha256Hex(text),
        totalFiles: manifest.totalFiles,
        totalBytes: manifest.totalBytes,
        failedFiles: manifest.failedFiles,
        files: manifest.files.map((file) => ({
          id: file.id,
          name: file.name,
          drivePath: file.drivePath,
          kind: file.kind,
          bytes: file.bytes,
          ...(file.original === undefined ? {} : { original: file.original }),
          ...(file.text === undefined ? {} : { text: file.text }),
          ...(file.error === undefined ? {} : { error: file.error }),
        })),
        sources: manifest.sources.map((source) => source.ref.trim()),
      },
    };
    return { taskId: manifest.taskId, result };
  } catch {
    return null;
  }
};

const fileSha = async (file: string) => sha256Hex(await fs.readFile(file));

/** Refuses a snapshot path that goes through a symlink, so writes and cleanup stay in the worktree. */
const assertNoSymlinks = async (worktree: string, relRoot: string) => {
  let current = worktree;
  for (const segment of relRoot.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat === null) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DriveApiError(
        `${path.relative(worktree, current)} is not a plain folder; the Drive snapshot was not written.`,
      );
    }
  }
};

/** True when every folder on `rel` is a real folder and the last part a regular file (no symlinks). */
const plainPath = async (worktree: string, rel: string) => {
  const segments = rel.split("/");
  let current = worktree;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat === null || stat.isSymbolicLink()) return false;
    if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  return true;
};

/** The repo's info/exclude path as git resolves it (linked worktrees included); null outside git. */
const gitExcludePath = (worktree: string) =>
  new Promise<string | null>((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { cwd: worktree, timeout: 10_000 },
      (error, stdout) => resolve(error === null ? stdout.trim() || null : null),
    );
  });

/** Keeps snapshots out of git without touching the project's .gitignore. */
const ensureIgnored = async (worktree: string) => {
  const exclude = await gitExcludePath(worktree);
  // Not a git checkout: there is nothing to keep the snapshot out of.
  if (exclude === null) return;
  const line = "/.ai_os/drive/";
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  const current = await fs.readFile(exclude, "utf8").catch(() => "");
  if (!current.split("\n").includes(line)) {
    await fs.appendFile(
      exclude,
      `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`,
    );
  }
};

/** Snapshot still present and unchanged; used before a task launches or resumes. */
export const verifySnapshot = async (worktree: string, ref: DriveManifestRefV1) => {
  // The root is one plain folder under .ai_os/drive, and nothing on the way is a symlink.
  const rootName = ref.root.slice(DRIVE_SNAPSHOT_DIR.length + 1);
  if (
    !ref.root.startsWith(`${DRIVE_SNAPSHOT_DIR}/`) ||
    rootName.length === 0 ||
    rootName.includes("/") ||
    rootName === "." ||
    rootName === ".." ||
    rootName === ".tmp"
  ) {
    return `The Drive snapshot ${ref.root} is not a snapshot folder.`;
  }
  if (!(await plainPath(worktree, `${ref.root}/manifest.json`))) {
    return `The Drive snapshot ${ref.root} is missing or not a plain local copy.`;
  }
  const text = await fs
    .readFile(path.join(worktree, ...ref.root.split("/"), "manifest.json"), "utf8")
    .catch(() => null);
  if (text === null) return `The Drive snapshot ${ref.root} is missing.`;
  if (sha256Hex(text) !== ref.manifestSha256) return `The Drive snapshot ${ref.root} was changed.`;
  // Every copied file must still be there, byte for byte.
  let files: Array<Record<string, unknown>> = [];
  try {
    files = (JSON.parse(text) as { files?: Array<Record<string, unknown>> }).files ?? [];
  } catch {
    return `The Drive snapshot ${ref.root} has an unreadable manifest.`;
  }
  for (const file of files) {
    for (const [pathKey, shaKey] of [
      ["original", "originalSha256"],
      ["text", "textSha256"],
    ] as const) {
      const rel = file[pathKey];
      if (typeof rel !== "string") continue;
      const segments = rel.split("/");
      if (
        !rel.startsWith(`${ref.root}/`) ||
        segments.some((part) => part === ".." || part === "")
      ) {
        return `The Drive snapshot ${ref.root} lists a file outside the snapshot.`;
      }
      if (!(await plainPath(worktree, rel))) {
        return `The Drive snapshot file ${rel} is missing or not a plain local copy.`;
      }
      const actual = await fileSha(path.join(worktree, ...rel.split("/"))).catch(() => null);
      if (actual === null) return `The Drive snapshot file ${rel} is missing.`;
      if (actual !== file[shaKey]) return `The Drive snapshot file ${rel} was changed.`;
    }
  }
  return null;
};
