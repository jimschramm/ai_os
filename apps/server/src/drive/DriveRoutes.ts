/**
 * Drive HTTP routes on the T3 server, for ai_os projects only. The Drive token
 * never leaves the server: clients (the live driver, the web app) send links
 * and get file lists or a snapshot reference back. Every route names a project
 * with Drive turned on; nothing here reads Drive for anything else.
 *
 *   POST /api/drive/search    { projectId, query, limit? }       read scope
 *        names only, to pick a file to attach to that project's task
 *   POST /api/drive/list      { projectId, ref? }                read scope
 *        a folder inside the project's Drive folders (default: its inputs)
 *   POST /api/drive/snapshot  { projectId, taskId, refs[] }      operate scope
 *        -> { jobId }; the job is saved to disk and resumes after a restart
 *   POST /api/drive/snapshot/status { jobId }                    read scope
 *        -> { state: "running", done, total } | { state: "done", manifest } | { state: "failed", error }
 *   POST /api/drive/verify    { projectId, manifest }            read scope
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
} from "@t3tools/contracts";
import { decodeDriveManifestRefV1 } from "@t3tools/ai-os-contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authorize, authResponse } from "../aiOsBoard.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { DRIVE_CONTENT_DIR, makeContentStore } from "./ContentStore.ts";
import { makeDriveApi, parseDriveRef } from "./DriveApi.ts";
import { buildSnapshot, resolveRef, verifySnapshot } from "./DriveReader.ts";
import { DRIVE_JOBS_DIR, DriveJobStore, type DriveJob, safeProjectDir } from "./DriveJobStore.ts";
import { isInsideFolders, projectRoots } from "./projectFolders.ts";
import { DRIVE_CREDENTIALS_SECRET_NAME, decodeCredentials } from "./GoogleDriveAuth.ts";

export const DRIVE_SEARCH_PATH = "/api/drive/search";
export const DRIVE_LIST_PATH = "/api/drive/list";
export const DRIVE_SNAPSHOT_PATH = "/api/drive/snapshot";
export const DRIVE_VERIFY_PATH = "/api/drive/verify";
export const DRIVE_SNAPSHOT_STATUS_PATH = "/api/drive/snapshot/status";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const json = (status: number, body: unknown) =>
  HttpServerResponse.text(encodeJson(body), { status, contentType: "application/json" });

class DriveRouteError extends Schema.TaggedError<DriveRouteError>()("DriveRouteError", {
  status: Schema.Number,
  detail: Schema.String,
}) {}

const bad = (detail: string, status = 400) => new DriveRouteError({ status, detail });

const body = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  const parsed = yield* Effect.try({
    try: () => decodeJson(text),
    catch: () => bad("Invalid JSON."),
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return yield* bad("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
});

const stringField = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const publicFile = (file: {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  webViewLink?: string;
  path?: string;
}) => ({
  id: file.id,
  name: file.name,
  mimeType: file.mimeType,
  size: file.size ?? null,
  modifiedTime: file.modifiedTime ?? null,
  webViewLink: file.webViewLink ?? null,
  ...(file.path === undefined ? {} : { path: file.path }),
});

/** Status and message for a Drive failure; the message never holds a token. */
const classify = (cause: unknown) => {
  const message = (cause instanceof Error ? cause.message : "Drive request failed.").slice(0, 500);
  const status = message.startsWith("Drive login needed")
    ? 401
    : (cause as { status?: number } | null)?.status === 404
      ? 404
      : message.startsWith("Not a Google Drive") || message.startsWith("Invalid task id")
        ? 400
        : message.startsWith("A Drive snapshot already exists")
          ? 409
          : (cause as { status?: number } | null)?.status === 403
            ? 403
            : 502;
  return { status, detail: message };
};

const fromPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => bad(classify(cause).detail, classify(cause).status),
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const projects = yield* ProjectService.ProjectService;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* ServerSettings.ServerSettingsService;
    const jobs = new DriveJobStore(path.join(config.stateDir, DRIVE_JOBS_DIR));
    /** Content is kept per project so it is reused only by that project. */
    // One store per project for the server's life, so its per-entry write
    // queue covers every job of that project.
    const stores = new Map<string, ReturnType<typeof makeContentStore>>();
    const storeFor = (projectId: string) => {
      let store = stores.get(projectId);
      if (store === undefined) {
        store = makeContentStore(
          path.join(config.stateDir, DRIVE_CONTENT_DIR, safeProjectDir(projectId)),
        );
        stores.set(projectId, store);
      }
      return store;
    };

    const api = Effect.gen(function* () {
      const stored = yield* secrets
        .get(DRIVE_CREDENTIALS_SECRET_NAME)
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      const credentials = Option.isSome(stored) ? decodeCredentials(stored.value) : null;
      if (credentials === null || credentials.token === null) {
        return yield* bad("Drive login needed: run `drive login` on this machine.", 401);
      }
      return makeDriveApi(credentials);
    });

    const worktreeOf = (projectId: string) =>
      Effect.gen(function* () {
        const project = yield* projects
          .getById(ProjectId.make(projectId))
          .pipe(Effect.mapError(() => bad("Could not read the project.", 500)));
        if (Option.isNone(project)) return yield* bad(`No project ${projectId}.`, 404);
        return project.value.workspaceRoot;
      });

    /** The project's Drive settings; Drive must be on for the project. */
    const projectDrive = (projectId: string) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(() => bad("Could not read settings.", 500)),
        );
        const drive = current.projectSettingsOverrides[ProjectId.make(projectId)]?.drive;
        if (drive === undefined || !drive.enabled) {
          return yield* bad(
            `Drive is off for project ${projectId}. Turn it on with \`drive project ${projectId}\`.`,
            403,
          );
        }
        return drive;
      });

    type Scope = typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope;
    const handle = (
      scope: Scope | ((input: Record<string, unknown>) => Scope),
      run: (input: Record<string, unknown>) => Effect.Effect<unknown, DriveRouteError>,
    ) =>
      Effect.gen(function* () {
        // A fixed scope is checked before the body is read.
        if (typeof scope !== "function") yield* authorize(scope);
        const input = yield* body;
        if (typeof scope === "function") yield* authorize(scope(input));
        return json(200, yield* run(input));
      }).pipe(
        Effect.catchTags({
          ...authResponse,
          DriveRouteError: (error) => Effect.succeed(json(error.status, { error: error.detail })),
        }),
      );

    const needProject = (input: Record<string, unknown>) => {
      const projectId = stringField(input, "projectId");
      return projectId === null ? Effect.fail(bad("Pass projectId.")) : Effect.succeed(projectId);
    };

    const search = handle(AuthOrchestrationReadScope, (input) =>
      Effect.gen(function* () {
        // Names only, to pick a file to attach to this project's task; no content is read.
        yield* projectDrive(yield* needProject(input));
        const query = stringField(input, "query");
        if (query === null) return yield* bad("Pass a search query.");
        const limit =
          typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
            ? input.limit
            : 25;
        const drive = yield* api;
        const files = yield* fromPromise(() => drive.search(query, limit));
        return { files: files.map(publicFile) };
      }),
    );

    const list = handle(AuthOrchestrationReadScope, (input) =>
      Effect.gen(function* () {
        const projectId = yield* needProject(input);
        const folders = yield* projectDrive(projectId);
        const ref = stringField(input, "ref") ?? folders.inputFolderId ?? null;
        if (ref === null)
          return yield* bad("This project has no Drive input folder; pass a folder.");
        const drive = yield* api;
        const id = parseDriveRef(ref);
        if (id === null) return yield* bad(`Not a Google Drive link or id: ${ref}`);
        const roots = yield* fromPromise(() => projectRoots(drive, folders));
        // The folder itself, after following a shortcut, must be the project's.
        const target = yield* fromPromise(async () => drive.resolve(await drive.getFile(id)));
        const inside = yield* fromPromise(() => isInsideFolders(drive, target.id, roots));
        if (!inside) {
          return yield* bad(
            "Folder evaluation works only on this project's Drive folders (aios/projects/<name>/...). Attach other files with --drive instead.",
            403,
          );
        }
        // A shortcut to something outside the project is not part of it: it is
        // listed as skipped, to attach by id if wanted.
        const skipped: Array<ReturnType<typeof publicFile>> = [];
        const resolved = yield* fromPromise(() =>
          resolveRef(drive, target.id, {
            followShortcut: (target) => isInsideFolders(drive, target.id, roots),
            skipped: (target) => skipped.push(publicFile(target)),
          }),
        );
        return {
          skipped,
          root: publicFile(resolved.root),
          totalFiles: resolved.files.length,
          totalBytes: resolved.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
          files: resolved.files.map(publicFile),
        };
      }),
    );

    const startLock = Semaphore.makeUnsafe(1);

    /** Runs (or resumes) a snapshot job, saving its state as it goes. */
    const runJob = (
      job: DriveJob,
      worktree: string,
      drive: ReturnType<typeof makeDriveApi>,
      folders: { readonly inputFolderId?: string; readonly outputFolderId?: string },
      resume: boolean,
    ) => {
      // Inside an attached folder, a shortcut is read only when its target is in
      // the project's folders or in a folder attached to this task.
      let allowed: Promise<string[]> | undefined;
      const followShortcut = async (target: { id: string }) => {
        // Attachments count by what they resolve to: an attached shortcut to a
        // folder allows shortcuts inside that folder's own tree.
        allowed ??= Promise.all([
          projectRoots(drive, folders),
          ...job.refs.flatMap((ref) => {
            const id = parseDriveRef(ref);
            return id === null
              ? []
              : [
                  drive
                    .getFile(id)
                    .then((file) => drive.resolve(file))
                    .then((target) => [id, target.id])
                    .catch(() => [id]),
                ];
          }),
        ]).then((lists) => [...new Set(lists.flat())]);
        return isInsideFolders(drive, target.id, await allowed);
      };
      return buildSnapshot({
        api: drive,
        store: storeFor(job.projectId),
        worktree,
        taskId: job.taskId,
        refs: job.refs,
        resume,
        ...(job.state === "running" && job.pinnedManifestSha256 !== undefined
          ? { expectedManifestSha256: job.pinnedManifestSha256 }
          : {}),
        // Pinned in the job file before the snapshot is published.
        onPublish: (manifestSha256) =>
          jobs.save({
            ...job,
            state: "running",
            done: 0,
            total: 0,
            current: null,
            pinnedManifestSha256: manifestSha256,
          }),
        followShortcut,
        onProgress: (done, total, current) => {
          // Progress is best effort; the final state is what counts.
          jobs.save({ ...job, state: "running", done, total, current }).catch(() => undefined);
        },
      })
        .then(
          (result) => jobs.save({ ...job, state: "done", manifest: result.ref }),
          (cause: unknown) => {
            const failed = classify(cause);
            return jobs.save({
              ...job,
              state: "failed",
              error: failed.detail,
              status: failed.status,
            });
          },
        )
        .catch(() => {
          // The final state could not be saved: the job stays "running" on disk and
          // resumes (reusing the finished snapshot) on the next start.
        });
    };

    const snapshot = handle(AuthOrchestrationOperateScope, (input) =>
      Effect.gen(function* () {
        const projectId = yield* needProject(input);
        const taskId = stringField(input, "taskId");
        const refs = Array.isArray(input.refs)
          ? input.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "")
          : [];
        if (taskId === null || refs.length === 0) {
          return yield* bad("Pass projectId, taskId and at least one Drive link.");
        }
        // Files attached by link or pick, or the project's own folders, for this project's task.
        const folders = yield* projectDrive(projectId);
        const worktree = yield* worktreeOf(projectId);
        const drive = yield* api;
        const jobId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const job: DriveJob = {
          jobId,
          projectId,
          taskId,
          refs,
          state: "running",
          done: 0,
          total: 0,
          current: null,
        };
        // One job per task: checked and recorded under one lock.
        yield* startLock.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* fromPromise(() => jobs.running());
            if (active.some((other) => other.projectId === projectId && other.taskId === taskId)) {
              return yield* bad(`A Drive snapshot for task ${taskId} is already running.`, 409);
            }
            yield* fromPromise(() => jobs.save(job));
          }),
        );
        void runJob(job, worktree, drive, folders, false);
        return { jobId };
      }),
    );

    // Polling needs read scope; acknowledging (which deletes the job) needs operate.
    const snapshotStatus = handle(
      (input) => (input.ack === true ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope),
      (input) =>
        Effect.gen(function* () {
          const jobId = stringField(input, "jobId");
          const job = jobId === null ? null : yield* fromPromise(() => jobs.get(jobId));
          if (job === null) return yield* bad("No such snapshot job.", 404);
          if (job.state === "running") {
            return { state: job.state, done: job.done, total: job.total, current: job.current };
          }
          // A finished job answers every poll until the client acknowledges it.
          if (input.ack === true) yield* fromPromise(() => jobs.remove(job.jobId));
          return job.state === "done"
            ? { state: job.state, manifest: job.manifest }
            : { state: job.state, error: job.error, status: job.status };
        }),
    );

    // Jobs that were running when the server stopped pick up where they left off:
    // files already read come from the project's content store.
    const pending = yield* Effect.promise(() => jobs.running().catch(() => [] as DriveJob[]));
    const resumed = new Set<string>();
    for (const job of pending) {
      const key = `${job.projectId}\u0000${job.taskId}`;
      if (resumed.has(key)) {
        yield* Effect.promise(() =>
          jobs.save({
            ...job,
            state: "failed",
            error: `Another Drive snapshot for task ${job.taskId} was resumed instead.`,
            status: 409,
          }),
        );
        continue;
      }
      resumed.add(key);
      const worktree = yield* worktreeOf(job.projectId).pipe(Effect.orElseSucceed(() => null));
      const drive = yield* api.pipe(Effect.orElseSucceed(() => null));
      // Drive may have been turned off for the project while the server was down.
      const folders = yield* projectDrive(job.projectId).pipe(Effect.orElseSucceed(() => null));
      if (worktree === null || drive === null || folders === null) {
        yield* Effect.promise(() =>
          jobs.save({
            ...job,
            state: "failed",
            error:
              worktree === null
                ? `Project ${job.projectId} is gone; the Drive snapshot was not resumed.`
                : folders === null
                  ? `Drive is off for project ${job.projectId}; the Drive snapshot was not resumed.`
                  : "Drive login needed: run `drive login` on this machine.",
            status: worktree === null ? 404 : folders === null ? 403 : 401,
          }),
        );
        continue;
      }
      yield* Effect.logInfo(`Resuming Drive snapshot job ${job.jobId} for task ${job.taskId}.`);
      void runJob(job, worktree, drive, folders, true);
    }

    const verify = handle(AuthOrchestrationReadScope, (input) =>
      Effect.gen(function* () {
        const projectId = stringField(input, "projectId");
        if (projectId === null) return yield* bad("Pass projectId.");
        const manifest = yield* decodeDriveManifestRefV1(input.manifest).pipe(
          Effect.mapError(() => bad("Invalid Drive manifest.")),
        );
        const worktree = yield* worktreeOf(projectId);
        return { problem: yield* fromPromise(() => verifySnapshot(worktree, manifest)) };
      }),
    );

    return Layer.mergeAll(
      HttpRouter.add("POST", DRIVE_SEARCH_PATH, search),
      HttpRouter.add("POST", DRIVE_LIST_PATH, list),
      HttpRouter.add("POST", DRIVE_SNAPSHOT_PATH, snapshot),
      HttpRouter.add("POST", DRIVE_SNAPSHOT_STATUS_PATH, snapshotStatus),
      HttpRouter.add("POST", DRIVE_VERIFY_PATH, verify),
    );
  }),
);
