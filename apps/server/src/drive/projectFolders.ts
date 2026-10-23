// @effect-diagnostics nodeBuiltinImport:off - plain module over DriveApi; the CLI wraps it in Effect.tryPromise.
/**
 * Project folders in Jim's Drive: `My Drive/aios/projects/<project>/inputs`
 * and `/outputs`. Existing folders are reused (never duplicated); only missing
 * ones are created. Nothing is renamed, moved or deleted.
 */
import { type DriveApi, DriveApiError } from "./DriveApi.ts";

export const AIOS_ROOT_FOLDER = "aios";
export const AIOS_PROJECTS_FOLDER = "projects";

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
  const aios = await api.findChildFolder("root", AIOS_ROOT_FOLDER);
  if (aios === null) {
    throw new DriveApiError(
      `No "${AIOS_ROOT_FOLDER}" folder at the top of My Drive. Create it (with a "${AIOS_PROJECTS_FOLDER}" folder inside), or pass --output/--input.`,
    );
  }
  const projects = await api.findChildFolder(aios.id, AIOS_PROJECTS_FOLDER);
  if (projects === null) {
    throw new DriveApiError(
      `No "${AIOS_PROJECTS_FOLDER}" folder inside My Drive/${AIOS_ROOT_FOLDER}. Create it, or pass --output/--input.`,
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
