// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - plain Node client so the RFP app can reuse it; callers wrap it in Effect.tryPromise.
/**
 * Minimal Google Drive v3 client for ai_os.
 *
 * Read-only toward everything it did not create: the only write is
 * `createFolder`, used for the project's own `aios/projects/<name>/...`
 * folders. There is no update, delete, trash, move or permission call.
 */
import {
  DriveAuthError,
  type FetchLike,
  GOOGLE_REQUEST_TIMEOUT_MS,
  refreshAccessToken,
  type StoredDriveCredentials,
} from "./GoogleDriveAuth.ts";

const API = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
/** Downloads have no size cap, so allow far longer than a metadata call. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,md5Checksum,parents,webViewLink,trashed,driveId,shortcutDetails(targetId,targetMimeType)";

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly modifiedTime?: string;
  readonly md5Checksum?: string;
  readonly parents?: readonly string[];
  readonly webViewLink?: string;
  readonly trashed?: boolean;
  readonly driveId?: string;
  readonly shortcutDetails?: { readonly targetId?: string; readonly targetMimeType?: string };
}

/** A file found under a folder, with its path relative to that folder. */
export interface DriveListedFile extends DriveFile {
  readonly path: string;
}

export class DriveApiError extends Error {
  override readonly name = "DriveApiError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const toFile = (raw: Record<string, unknown>): DriveFile => {
  const size = typeof raw.size === "string" ? Number(raw.size) : undefined;
  return {
    ...(raw as unknown as DriveFile),
    ...(size === undefined || Number.isNaN(size) ? {} : { size }),
  };
};

/** Escapes a value for a Drive `q` string literal. */
export const quoteQuery = (value: string) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export interface ListRecursiveOptions {
  readonly followShortcut?: (target: DriveFile) => Promise<boolean>;
  readonly skipped?: (target: DriveListedFile) => void;
}

export interface DriveApi {
  readonly getFile: (id: string) => Promise<DriveFile>;
  /** Follows a shortcut to its target; returns other files unchanged. */
  readonly resolve: (file: DriveFile) => Promise<DriveFile>;
  readonly listChildren: (folderId: string) => Promise<DriveFile[]>;
  /**
   * Every non-folder file under `folderId`, at any depth. Shortcuts are followed
   * once, and only where `options.followShortcut` agrees; the others go to
   * `options.skipped`.
   */
  readonly listRecursive: (
    folderId: string,
    options?: ListRecursiveOptions,
  ) => Promise<DriveListedFile[]>;
  /** Full-text and name search over everything Jim can read, newest first. */
  readonly search: (text: string, limit?: number) => Promise<DriveFile[]>;
  readonly download: (id: string) => Promise<Uint8Array>;
  readonly exportAs: (id: string, mimeType: string) => Promise<Uint8Array>;
  readonly findChildFolder: (parentId: string, name: string) => Promise<DriveFile | null>;
  /** The only write. Used for ai_os's own project folders, never on originals. */
  readonly createFolder: (parentId: string, name: string) => Promise<DriveFile>;
}

export const makeDriveApi = (
  credentials: StoredDriveCredentials,
  doFetch: FetchLike = fetch,
): DriveApi => {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  const token = async () => {
    if (cached === null || cached.expiresAt - 60_000 < Date.now()) {
      cached = await refreshAccessToken(credentials, doFetch);
    }
    return cached.accessToken;
  };

  const call = async (
    path: string,
    params: Record<string, string>,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<Response> => {
    const url = `${API}${path}?${new URLSearchParams({ supportsAllDrives: "true", ...params })}`;
    const send = async () =>
      doFetch(url, {
        method: init.method ?? "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(init.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${await token()}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    let response = await send();
    if (response.status === 401) {
      cached = null;
      response = await send();
    }
    // Only reads are retried: a failed create may still have happened.
    const retryable = (init.method ?? "GET") === "GET";
    for (
      let attempt = 0;
      retryable && attempt < 4 && [429, 500, 502, 503].includes(response.status);
      attempt++
    ) {
      await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
      response = await send();
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: unknown };
      };
      const detail =
        typeof body.error?.message === "string" ? body.error.message.slice(0, 300) : "";
      throw new DriveApiError(
        response.status === 401
          ? "Drive login needed: Google rejected the token. Run `drive login`."
          : `Drive request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    return response;
  };

  const json = async (path: string, params: Record<string, string>, init = {}) =>
    (await (await call(path, params, init)).json()) as Record<string, unknown>;
  const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

  const getFile = async (id: string) =>
    toFile(await json(`/files/${encodeURIComponent(id)}`, { fields: FILE_FIELDS }));

  const resolve = async (file: DriveFile) => {
    if (file.mimeType !== SHORTCUT_MIME) return file;
    const target = file.shortcutDetails?.targetId;
    if (target === undefined) throw new DriveApiError(`Shortcut ${file.name} has no target.`);
    return getFile(target);
  };

  const listQuery = async (
    q: string,
    extra: Record<string, string> = {},
    limit = Infinity,
    /** Set for folder listings: a partial answer would silently drop files. */
    complete: string | null = null,
  ) => {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const page = await json("/files", {
        q,
        fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
        pageSize: String(Math.min(1000, limit)),
        includeItemsFromAllDrives: "true",
        corpora: "allDrives",
        ...extra,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      if (complete !== null && page.incompleteSearch === true) {
        throw new DriveApiError(
          `Drive returned an incomplete listing of ${complete}; nothing was skipped silently. Run it again.`,
        );
      }
      for (const raw of (page.files as Record<string, unknown>[] | undefined) ?? []) {
        files.push(toFile(raw));
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken !== undefined && files.length < limit);
    return files.slice(0, limit);
  };

  // A folder is listed in its own corpus (its shared drive, or the user's
  // files), not across all drives, where Drive may answer only in part.
  const driveIds = new Map<string, Promise<string | undefined>>();
  const driveIdOf = (folderId: string) => {
    let known = driveIds.get(folderId);
    if (known === undefined) {
      known = getFile(folderId).then(
        (file) => file.driveId,
        () => undefined,
      );
      driveIds.set(folderId, known);
    }
    return known;
  };
  const corpusOf = async (folderId: string): Promise<Record<string, string>> => {
    const driveId = await driveIdOf(folderId);
    return driveId === undefined ? { corpora: "user" } : { corpora: "drive", driveId };
  };

  const listChildren = async (folderId: string) =>
    listQuery(
      `${quoteQuery(folderId)} in parents and trashed = false`,
      { orderBy: "folder,name", ...(await corpusOf(folderId)) },
      Infinity,
      `folder ${folderId}`,
    );

  const listRecursive = async (folderId: string, options: ListRecursiveOptions = {}) => {
    const out: DriveListedFile[] = [];
    const seen = new Set<string>([folderId]);
    const walk = async (id: string, prefix: string) => {
      for (const child of await listChildren(id)) {
        const file =
          child.mimeType === SHORTCUT_MIME ? await resolve(child).catch(() => null) : child;
        if (file === null || file.trashed === true) continue;
        const path = `${prefix}${child.name}`;
        if (
          child.mimeType === SHORTCUT_MIME &&
          options.followShortcut !== undefined &&
          !(await options.followShortcut(file))
        ) {
          options.skipped?.({ ...file, path });
          continue;
        }
        if (file.mimeType === FOLDER_MIME) {
          // A shortcut loop or a folder linked twice is walked once.
          if (seen.has(file.id)) continue;
          seen.add(file.id);
          if (!driveIds.has(file.id)) driveIds.set(file.id, Promise.resolve(file.driveId));
          await walk(file.id, `${path}/`);
        } else if (!seen.has(file.id)) {
          seen.add(file.id);
          out.push({ ...file, path });
        }
      }
    };
    await walk(folderId, "");
    return out;
  };

  const search = (text: string, limit = 25) =>
    listQuery(
      `(name contains ${quoteQuery(text)} or fullText contains ${quoteQuery(text)}) and trashed = false`,
      { orderBy: "modifiedTime desc" },
      limit,
    );

  const download = async (id: string) =>
    bytes(
      await call(
        `/files/${encodeURIComponent(id)}`,
        { alt: "media" },
        { timeoutMs: DOWNLOAD_TIMEOUT_MS },
      ),
    );

  const exportAs = async (id: string, mimeType: string) =>
    bytes(
      await call(
        `/files/${encodeURIComponent(id)}/export`,
        { mimeType },
        { timeoutMs: DOWNLOAD_TIMEOUT_MS },
      ),
    );

  const findChildFolder = async (parentId: string, name: string) => {
    const found = await listQuery(
      `${quoteQuery(parentId)} in parents and name = ${quoteQuery(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`,
      { orderBy: "createdTime", ...(await corpusOf(parentId)) },
      Infinity,
      // A partial answer here could make a duplicate project folder.
      `folder ${parentId}`,
    );
    return found[0] ?? null;
  };

  const createFolder = async (parentId: string, name: string) => {
    if (name.trim().length === 0) throw new DriveAuthError("Folder name is empty.");
    return toFile(
      await json(
        "/files",
        { fields: FILE_FIELDS },
        { method: "POST", body: { name, mimeType: FOLDER_MIME, parents: [parentId] } },
      ),
    );
  };

  return {
    getFile,
    resolve,
    listChildren,
    listRecursive,
    search,
    download,
    exportAs,
    findChildFolder,
    createFolder,
  };
};

/**
 * File id from a Drive/Docs/Sheets/Slides link or a bare id. Folder links are
 * accepted too; the caller checks the mime type.
 */
export const parseDriveRef = (input: string): string | null => {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return null;
  const byPath =
    /\/(?:file|document|spreadsheets|presentation|drawings|forms)\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(
      url.pathname,
    );
  if (byPath?.[1] !== undefined) return byPath[1];
  const folder = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (folder?.[1] !== undefined) return folder[1];
  const id = url.searchParams.get("id");
  return id !== null && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
};
