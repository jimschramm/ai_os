// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node module so the RFP app can reuse it; callers wrap it in Effect.tryPromise.
/**
 * Reads Drive files into the content store and copies a task's files into the
 * project worktree. Never writes to Drive.
 */
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
  try {
    if (file.mimeType.startsWith(GOOGLE)) {
      const kind = file.mimeType.slice(GOOGLE.length);
      if (kind === "document" || kind === "presentation") {
        const original = await api.exportAs(file.id, kind === "document" ? DOCX : PPTX);
        const text = decode(await api.exportAs(file.id, "text/plain"));
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
export const resolveRef = async (api: DriveApi, ref: string): Promise<ResolvedRef> => {
  const id = parseDriveRef(ref);
  if (id === null) throw new DriveApiError(`Not a Google Drive link or id: ${ref}`);
  const root = await api.resolve(await api.getFile(id));
  if (root.mimeType === FOLDER_MIME) {
    return { ref, root, files: await api.listRecursive(root.id) };
  }
  return { ref, root, files: [{ ...root, path: root.name }] };
};

const safeName = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "file";

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
  /** Called after each file with (done, total, Drive path). */
  readonly onProgress?: (done: number, total: number, drivePath: string) => void;
}): Promise<SnapshotResult> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.taskId)) {
    throw new DriveApiError(`Invalid task id: ${input.taskId}`);
  }
  const relRoot = `${DRIVE_SNAPSHOT_DIR}/${input.taskId.replaceAll(":", "_")}`;
  const absRoot = path.join(input.worktree, ...relRoot.split("/"));
  // A snapshot is immutable: never overwrite one a task already points at.
  if (
    await fs.stat(absRoot).then(
      () => true,
      () => false,
    )
  ) {
    throw new DriveApiError(`A Drive snapshot already exists at ${relRoot}.`);
  }
  const resolved: ResolvedRef[] = [];
  for (const ref of input.refs) resolved.push(await resolveRef(input.api, ref));

  await ensureIgnored(input.worktree);
  const temporary = `${absRoot}.tmp-${Date.now()}`;
  await fs.mkdir(temporary, { recursive: true });
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
        const stem = `${String(index).padStart(4, "0")}-${safeName(file.name)}`;
        let original: string | undefined;
        let text: string | undefined;
        if (stored.originalPath !== null) {
          const ext = path.extname(stored.originalPath);
          const target = stem.toLowerCase().endsWith(ext.toLowerCase()) ? stem : `${stem}${ext}`;
          await fs.copyFile(stored.originalPath, path.join(temporary, target));
          await fs.chmod(path.join(temporary, target), 0o444);
          original = `${relRoot}/${target}`;
        }
        if (stored.textPath !== null) {
          const target = `${stem}.txt`;
          await fs.copyFile(stored.textPath, path.join(temporary, target));
          await fs.chmod(path.join(temporary, target), 0o444);
          text = `${relRoot}/${target}`;
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
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(temporary, "manifest.json"), manifestText, { mode: 0o444 });
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

/** Keeps snapshots out of git without touching the project's .gitignore. */
const ensureIgnored = async (worktree: string) => {
  const exclude = path.join(worktree, ".git", "info", "exclude");
  const line = "/.ai_os/drive/";
  const current = await fs.readFile(exclude, "utf8").catch(() => null);
  if (current === null) {
    // Not a plain git checkout (or a linked worktree): the agent sees the folder untracked.
    return;
  }
  if (!current.split("\n").includes(line)) {
    await fs.appendFile(
      exclude,
      `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`,
    );
  }
};

/** Snapshot still present and unchanged; used before a task launches or resumes. */
export const verifySnapshot = async (worktree: string, ref: DriveManifestRefV1) => {
  const text = await fs
    .readFile(path.join(worktree, ...ref.root.split("/"), "manifest.json"), "utf8")
    .catch(() => null);
  if (text === null) return `The Drive snapshot ${ref.root} is missing.`;
  if (sha256Hex(text) !== ref.manifestSha256) return `The Drive snapshot ${ref.root} was changed.`;
  return null;
};
