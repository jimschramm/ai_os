// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The Drive routes end to end over HTTP, with an in-memory Drive: project
 * boundaries, shortcut filtering, one job per task, and restart recovery.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type DriveApi, type DriveFile, FOLDER_MIME, SHORTCUT_MIME } from "./DriveApi.ts";
import { DRIVE_JOBS_DIR, DriveJobStore } from "./DriveJobStore.ts";
import * as DriveRoutes from "./DriveRoutes.ts";
import { AIOS_PROJECTS_FOLDER_ID } from "./projectFolders.ts";

const dirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const temp = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drive-routes-"));
  dirs.push(dir);
  return dir;
};

const INPUTS = "inputsFolder01";
const OTHER = "otherFolder001";
const files: DriveFile[] = [
  { id: AIOS_PROJECTS_FOLDER_ID, name: "projects", mimeType: FOLDER_MIME },
  { id: "projFolder0001", name: "usba", mimeType: FOLDER_MIME, parents: [AIOS_PROJECTS_FOLDER_ID] },
  { id: INPUTS, name: "inputs", mimeType: FOLDER_MIME, parents: ["projFolder0001"] },
  {
    id: "fileInside001",
    name: "brief.txt",
    mimeType: "text/plain",
    size: 6,
    modifiedTime: "2026-10-01T00:00:00.000Z",
    parents: [INPUTS],
  },
  {
    id: "shortcutOut01",
    name: "outside link",
    mimeType: SHORTCUT_MIME,
    parents: [INPUTS],
    shortcutDetails: { targetId: "fileOutside01", targetMimeType: "text/plain" },
  },
  { id: OTHER, name: "elsewhere", mimeType: FOLDER_MIME },
  {
    id: "fileOutside01",
    name: "private.txt",
    mimeType: "text/plain",
    size: 7,
    modifiedTime: "2026-10-01T00:00:00.000Z",
    parents: [OTHER],
  },
];
const bytes: Record<string, string> = { fileInside001: "inside", fileOutside01: "outside" };

/** In-memory Drive; `gate` holds downloads until released. */
const fakeDrive = (gate?: Promise<void>) => {
  const calls: string[] = [];
  const byId = new Map(files.map((file) => [file.id, file]));
  const get = (id: string) => {
    const file = byId.get(id);
    if (file === undefined) throw Object.assign(new Error("File not found"), { status: 404 });
    return file;
  };
  const resolve = async (file: DriveFile) =>
    file.mimeType === SHORTCUT_MIME ? get(file.shortcutDetails!.targetId!) : file;
  const api: DriveApi = {
    getFile: async (id) => get(id),
    resolve,
    listChildren: async (id) => files.filter((file) => file.parents?.includes(id)),
    listRecursive: async (id, options) => {
      const out: Array<DriveFile & { path: string }> = [];
      for (const child of files.filter((file) => file.parents?.includes(id))) {
        if (child.mimeType === SHORTCUT_MIME) {
          const target = await resolve(child);
          if ((await options?.followShortcut?.(target)) === true) {
            out.push({ ...target, path: child.name });
          } else {
            options?.skipped?.({ ...target, path: child.name });
          }
        } else if (child.mimeType !== FOLDER_MIME) out.push({ ...child, path: child.name });
      }
      return out;
    },
    search: async () => [],
    download: async (id) => {
      calls.push(`download ${id}`);
      if (gate !== undefined) await gate;
      return new TextEncoder().encode(bytes[id] ?? "");
    },
    exportAs: async () => new Uint8Array(),
    findChildFolder: async () => null,
    createFolder: async () => {
      throw new Error("no writes in these tests");
    },
  };
  return { api, calls };
};

const serve = (stateDir: string, worktree: string, drive: DriveApi, driveOn = true) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    DriveRoutes.layerWith({ driveApi: () => drive }).pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
            request.headers.authorization === `Bearer ${AuthOrchestrationOperateScope}`
              ? Effect.succeed({
                  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
                })
              : request.headers.authorization === `Bearer ${AuthOrchestrationReadScope}`
                ? Effect.succeed({ scopes: [AuthOrchestrationReadScope] })
                : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: () => Effect.succeed(Option.none()),
        } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProjectService.ProjectService, {
          getById: (id: string) =>
            Effect.succeed(
              id === "usba" ? Option.some({ workspaceRoot: worktree }) : Option.none(),
            ),
        } as unknown as ProjectService.ProjectService["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            projectSettingsOverrides: {
              usba: { drive: { enabled: driveOn, inputFolderId: INPUTS } },
              other: { drive: { enabled: true, inputFolderId: OTHER } },
            },
          }),
        } as unknown as ServerSettings.ServerSettingsService["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          stateDir,
        } as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const post = async (
    route: string,
    body: unknown,
    scope: string = AuthOrchestrationOperateScope,
  ) => {
    const response = await handler(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${scope}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { post, dispose };
};

const worktreeRepo = async () => {
  const worktree = await temp();
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  return worktree;
};

const waitDone = async (post: ReturnType<typeof serve>["post"], jobId: string) => {
  for (let i = 0; i < 200; i += 1) {
    const status = await post(DriveRoutes.DRIVE_SNAPSHOT_STATUS_PATH, { jobId });
    if (status.body.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("snapshot did not finish");
};

describe("Drive routes", () => {
  it("lists only the project's folders and skips shortcuts that lead outside it", async () => {
    const { post } = serve(await temp(), await worktreeRepo(), fakeDrive().api);
    const listed = await post(DriveRoutes.DRIVE_LIST_PATH, { projectId: "usba" });
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((file: { id: string }) => file.id)).toEqual(["fileInside001"]);
    expect(listed.body.skipped.map((file: { id: string }) => file.id)).toEqual(["fileOutside01"]);
    const outside = await post(DriveRoutes.DRIVE_LIST_PATH, { projectId: "usba", ref: OTHER });
    expect(outside.status).toBe(403);
  });

  it("refuses projects with Drive off and needs operate scope to snapshot", async () => {
    const off = serve(await temp(), await worktreeRepo(), fakeDrive().api, false);
    const refused = await off.post(DriveRoutes.DRIVE_SNAPSHOT_PATH, {
      projectId: "usba",
      taskId: "t1",
      refs: [INPUTS],
    });
    expect(refused.status).toBe(403);
    const on = serve(await temp(), await worktreeRepo(), fakeDrive().api);
    const readOnly = await on.post(
      DriveRoutes.DRIVE_SNAPSHOT_PATH,
      { projectId: "usba", taskId: "t1", refs: [INPUTS] },
      AuthOrchestrationReadScope,
    );
    expect(readOnly.status).toBe(403);
  });

  it("snapshots an attached folder without the outside shortcut, unless its target is attached too", async () => {
    const { post } = serve(await temp(), await worktreeRepo(), fakeDrive().api);
    const plain = await post(DriveRoutes.DRIVE_SNAPSHOT_PATH, {
      projectId: "usba",
      taskId: "t-plain",
      refs: [INPUTS],
    });
    const done = await waitDone(post, plain.body.jobId);
    expect(done.body.state).toBe("done");
    expect(done.body.manifest.files.map((file: { id: string }) => file.id)).toEqual([
      "fileInside001",
    ]);
    const attached = await post(DriveRoutes.DRIVE_SNAPSHOT_PATH, {
      projectId: "usba",
      taskId: "t-attached",
      refs: [INPUTS, OTHER],
    });
    const both = await waitDone(post, attached.body.jobId);
    expect(both.body.manifest.files.map((file: { id: string }) => file.id)).toContain(
      "fileOutside01",
    );
  });

  it("admits one job per task when two starts arrive at once", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { post } = serve(await temp(), await worktreeRepo(), fakeDrive(gate).api);
    const start = () =>
      post(DriveRoutes.DRIVE_SNAPSHOT_PATH, {
        projectId: "usba",
        taskId: "t-race",
        refs: [INPUTS],
      });
    const answers = await Promise.all([start(), start(), start()]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409, 409]);
    release();
    const winner = answers.find((answer) => answer.status === 200)!;
    expect((await waitDone(post, winner.body.jobId)).body.state).toBe("done");
  });

  it("after a restart between publishing and saving done, resumes onto the pinned snapshot", async () => {
    const stateDir = await temp();
    const worktree = await worktreeRepo();
    const first = fakeDrive();
    const server = serve(stateDir, worktree, first.api);
    const started = await server.post(DriveRoutes.DRIVE_SNAPSHOT_PATH, {
      projectId: "usba",
      taskId: "t-restart",
      refs: [INPUTS],
    });
    const done = await waitDone(server.post, started.body.jobId);
    const manifest = done.body.manifest;
    await server.dispose();
    // The crash: the job file still says running, with only the pin saved.
    const jobs = new DriveJobStore(path.join(stateDir, DRIVE_JOBS_DIR));
    const job = (await jobs.get(started.body.jobId))!;
    const { manifest: _dropped, ...rest } = job as typeof job & { manifest?: unknown };
    await jobs.save({
      ...rest,
      state: "running",
      done: 0,
      total: 0,
      current: null,
      pinnedManifestSha256: manifest.manifestSha256,
    });
    const second = fakeDrive();
    const restarted = serve(stateDir, worktree, second.api);
    const resumed = await waitDone(restarted.post, started.body.jobId);
    expect(resumed.body.state).toBe("done");
    expect(resumed.body.manifest.manifestSha256).toBe(manifest.manifestSha256);
    // The published snapshot was reused, not rebuilt from Drive.
    expect(second.calls.filter((call) => call.startsWith("download"))).toEqual([]);
    const checked = await restarted.post(DriveRoutes.DRIVE_VERIFY_PATH, {
      projectId: "usba",
      manifest: resumed.body.manifest,
    });
    expect(checked.body.problem).toBeNull();
  });
});
