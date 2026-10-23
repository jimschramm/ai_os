// @effect-diagnostics nodeBuiltinImport:off - plain module over DriveApi; the CLI wraps it in Effect.tryPromise.
/**
 * Project folders in Jim's Drive: `aios/projects/<project>/inputs` and
 * `/outputs`. The aios root and its `projects` folder already exist and are
 * addressed by id; they are never created here. Under `projects`, existing
 * project folders are reused (never duplicated) and only missing ones are
 * created. Nothing is renamed, moved or deleted.
 */
import * as path from "node:path";
import { lock } from "proper-lockfile";
import { type DriveApi, DriveApiError, FOLDER_MIME } from "./DriveApi.ts";

/** My Drive/aios */
export const AIOS_ROOT_FOLDER_ID = "1Tnd7Xkg2ZXEhvsBt6KvnJA9_JOvRRdUT";
/** My Drive/aios/projects */
export const AIOS_PROJECTS_FOLDER_ID = "1PKIWeHg_8vSqRbPJX-bMHSR9hKs7Ov7r";

export interface ProjectFolders {
  readonly projectFolderId: string;
  readonly inputFolderId: string;
  readonly outputFolderId: string;
  /** Names of folders this call created, e.g. ["Tournament", "inputs"]. */
  readonly created: readonly string[];
}

/**
 * `lockDir` (the CLI passes the server secret folder) serializes provisioning
 * across processes, so two runs never both create the same folder.
 */
export const ensureProjectFolders = async (
  api: DriveApi,
  projectName: string,
  options: { readonly lockDir?: string } = {},
): Promise<ProjectFolders> => {
  if (options.lockDir === undefined) return provision(api, projectName);
  const release = await lock(path.join(options.lockDir, "drive-project-folders"), {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 500 },
  }).catch(() => {
    throw new DriveApiError("Another run is setting up Drive project folders. Try again.");
  });
  try {
    return await provision(api, projectName);
  } finally {
    await release().catch(() => undefined);
  }
};

const provision = async (api: DriveApi, projectName: string): Promise<ProjectFolders> => {
  const name = projectName.trim();
  if (name.length === 0) throw new DriveApiError("The project name is empty.");
  if (/[/\\]/.test(name))
    throw new DriveApiError("The project folder name cannot contain / or \\.");
  const projects = await api.getFile(AIOS_PROJECTS_FOLDER_ID).catch(() => null);
  if (projects === null || projects.mimeType !== FOLDER_MIME || projects.trashed === true) {
    throw new DriveApiError(
      `The aios/projects folder (${AIOS_PROJECTS_FOLDER_ID}) is not reachable with this Drive login.`,
    );
  }
  const created: string[] = [];
  // Creates are not retried. After any create (or a failed one, which may
  // still have happened), look again and use the oldest folder of that name,
  // so concurrent or uncertain runs all settle on the same folder.
  const findOrCreate = async (parentId: string, folder: string) => {
    const found = await api.findChildFolder(parentId, folder);
    if (found !== null) return found;
    const made = await api.createFolder(parentId, folder).then(
      (file) => ({ file, error: null }),
      (error: unknown) => ({ file: null, error }),
    );
    const settled = await api.findChildFolder(parentId, folder);
    if (settled === null) {
      if (made.file !== null) {
        created.push(folder);
        return made.file;
      }
      throw made.error;
    }
    if (made.file !== null && made.file.id === settled.id) created.push(folder);
    return settled;
  };
  const project = await findOrCreate(projects.id, name);
  const inputs = await findOrCreate(project.id, "inputs");
  const outputs = await findOrCreate(project.id, "outputs");
  return {
    projectFolderId: project.id,
    inputFolderId: inputs.id,
    outputFolderId: outputs.id,
    created,
  };
};

/**
 * The folders a project owns in Drive: its input and output folders and, when
 * they sit in `aios/projects/<name>/`, that project folder itself. A configured
 * folder outside aios/projects is not a project folder; its files can still be
 * attached to a task one by one.
 */
export const projectRoots = async (
  api: DriveApi,
  drive: { readonly inputFolderId?: string; readonly outputFolderId?: string },
): Promise<string[]> => {
  const roots = new Set<string>();
  for (const id of [drive.inputFolderId, drive.outputFolderId]) {
    if (id === undefined || id === AIOS_PROJECTS_FOLDER_ID || id === AIOS_ROOT_FOLDER_ID) continue;
    if (!(await isInsideFolders(api, id, [AIOS_PROJECTS_FOLDER_ID]))) continue;
    roots.add(id);
    const folder = await api.getFile(id).catch(() => null);
    for (const parent of folder?.parents ?? []) {
      const parentFolder = await api.getFile(parent).catch(() => null);
      if (parentFolder?.parents?.includes(AIOS_PROJECTS_FOLDER_ID) === true) roots.add(parent);
    }
  }
  return [...roots];
};

/** Whether `id` is one of `roots` or sits (at any depth) inside one of them. */
export const isInsideFolders = async (
  api: DriveApi,
  id: string,
  roots: readonly string[],
): Promise<boolean> => {
  const wanted = new Set(roots);
  const seen = new Set<string>();
  let frontier = [id];
  // Drive folders are shallow in practice; 64 levels guards against loops.
  for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      if (wanted.has(current)) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const file = await api.getFile(current).catch(() => null);
      for (const parent of file?.parents ?? []) next.push(parent);
    }
    frontier = next;
  }
  return false;
};
