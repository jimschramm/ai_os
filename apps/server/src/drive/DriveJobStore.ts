// @effect-diagnostics nodeBuiltinImport:off - plain Node module; DriveRoutes calls it through promises.
/**
 * Drive snapshot jobs, one JSON file each under `<stateDir>/drive-jobs/`
 * (mode 600), so a job that was running when the server stopped resumes on
 * the next start. Writes go to a temp file and are renamed into place, and
 * saves for one job are applied in order.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DRIVE_JOBS_DIR = "drive-jobs";

export type DriveJob = {
  readonly jobId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly refs: readonly string[];
} & (
  | {
      readonly state: "running";
      readonly done: number;
      readonly total: number;
      readonly current: string | null;
    }
  | { readonly state: "done"; readonly manifest: unknown }
  | { readonly state: "failed"; readonly error: string; readonly status: number }
);

const JOB_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A project id as one safe folder name (ids are already path-safe; this enforces it). */
export const safeProjectDir = (projectId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId) || projectId.includes("..")) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  return projectId;
};

export class DriveJobStore {
  readonly dir: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(jobId: string) {
    if (!JOB_ID.test(jobId)) throw new Error(`Invalid job id: ${jobId}`);
    return path.join(this.dir, `${jobId}.json`);
  }

  /** Saves the job; saves of one job never overtake each other. */
  save(job: DriveJob): Promise<void> {
    const target = this.file(job.jobId);
    const previous = this.queues.get(job.jobId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(job)}\n`, { mode: 0o600 });
      await fs.rename(temporary, target);
    });
    const settled = next.catch(() => undefined);
    this.queues.set(job.jobId, settled);
    void settled.then(() => {
      if (this.queues.get(job.jobId) === settled) this.queues.delete(job.jobId);
    });
    return next;
  }

  async get(jobId: string): Promise<DriveJob | null> {
    if (!JOB_ID.test(jobId)) return null;
    await (this.queues.get(jobId) ?? Promise.resolve());
    const text = await fs.readFile(this.file(jobId), "utf8").catch(() => null);
    if (text === null) return null;
    try {
      return JSON.parse(text) as DriveJob;
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    await (this.queues.get(jobId) ?? Promise.resolve());
    await fs.rm(this.file(jobId), { force: true });
  }

  /** Jobs saved as running, e.g. cut short by a server restart. */
  async running(): Promise<DriveJob[]> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const jobs: DriveJob[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const job = await this.get(name.slice(0, -".json".length));
      if (job?.state === "running") jobs.push(job);
    }
    return jobs;
  }
}
