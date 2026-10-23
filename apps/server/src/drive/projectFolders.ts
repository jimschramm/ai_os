// @effect-diagnostics nodeBuiltinImport:off - plain module over DriveApi; the CLI wraps it in Effect.tryPromise.
/**
 * Project folders in Jim's Drive: `aios/projects/<project>/inputs` and
 * `/outputs`. The aios root and its `projects` folder already exist and are
 * addressed by id; they are never created here. Under `projects`, existing
 * project folders are reused (never duplicated) and only missing ones are
 * created. Nothing is renamed, moved or deleted.
 */
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

export const ensureProjectFolders = async (
  api: DriveApi,
  projectName: string,
): Promise<ProjectFolders> => {
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
  const findOrCreate = async (parentId: string, folder: string) => {
    const found = await api.findChildFolder(parentId, folder);
    if (found !== null) return found;
    created.push(folder);
    return api.createFolder(parentId, folder);
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
 * they sit in `aios/projects/<name>/`, that project folder itself.
 */
export const projectRoots = async (
  api: DriveApi,
  drive: { readonly inputFolderId?: string; readonly outputFolderId?: string },
): Promise<string[]> => {
  const roots = new Set<string>();
  for (const id of [drive.inputFolderId, drive.outputFolderId]) {
    if (id === undefined) continue;
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
      next.push(...(file?.parents ?? []));
    }
    frontier = next;
  }
  return false;
};
