/**
 * Drive HTTP routes on the T3 server. The Drive token never leaves the server:
 * clients (the live driver, the web app) send links and get file lists or a
 * snapshot reference back.
 *
 *   POST /api/drive/search    { query, limit? }               read scope
 *   POST /api/drive/list      { ref }                         read scope
 *   POST /api/drive/snapshot  { projectId, taskId, refs[] }   operate scope
 *        -> { jobId }; a big folder can take longer than one HTTP request may wait
 *   POST /api/drive/snapshot/status { jobId }                 read scope
 *        -> { state: "running", done, total } | { state: "done", manifest } | { state: "failed", error }
 *   POST /api/drive/verify    { projectId, manifest }         read scope
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
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authorize, authResponse } from "../aiOsBoard.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { DRIVE_CONTENT_DIR, makeContentStore } from "./ContentStore.ts";
import { makeDriveApi } from "./DriveApi.ts";
import { buildSnapshot, resolveRef, verifySnapshot } from "./DriveReader.ts";
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
    type Job =
      | { state: "running"; done: number; total: number; current: string | null }
      | { state: "done"; manifest: unknown }
      | { state: "failed"; error: string; status: number };
    const jobs = new Map<string, Job>();
    const store = makeContentStore(path.join(config.stateDir, DRIVE_CONTENT_DIR));

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

    const handle = (
      scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
      run: (input: Record<string, unknown>) => Effect.Effect<unknown, DriveRouteError>,
    ) =>
      Effect.gen(function* () {
        yield* authorize(scope);
        const input = yield* body;
        return json(200, yield* run(input));
      }).pipe(
        Effect.catchTags({
          ...authResponse,
          DriveRouteError: (error) => Effect.succeed(json(error.status, { error: error.detail })),
        }),
      );

    const search = handle(AuthOrchestrationReadScope, (input) =>
      Effect.gen(function* () {
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
        const ref = stringField(input, "ref");
        if (ref === null) return yield* bad("Pass a Drive link or id.");
        const drive = yield* api;
        const resolved = yield* fromPromise(() => resolveRef(drive, ref));
        return {
          root: publicFile(resolved.root),
          totalFiles: resolved.files.length,
          totalBytes: resolved.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
          files: resolved.files.map(publicFile),
        };
      }),
    );

    const snapshot = handle(AuthOrchestrationOperateScope, (input) =>
      Effect.gen(function* () {
        const projectId = stringField(input, "projectId");
        const taskId = stringField(input, "taskId");
        const refs = Array.isArray(input.refs)
          ? input.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "")
          : [];
        if (projectId === null || taskId === null || refs.length === 0) {
          return yield* bad("Pass projectId, taskId and at least one Drive link.");
        }
        const worktree = yield* worktreeOf(projectId);
        const drive = yield* api;
        const jobId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const job: Job = { state: "running", done: 0, total: 0, current: null };
        jobs.set(jobId, job);
        // Runs outside the request so the client can poll; the server keeps it in memory only.
        void buildSnapshot({
          api: drive,
          store,
          worktree,
          taskId,
          refs,
          onProgress: (done, total, current) => {
            jobs.set(jobId, { state: "running", done, total, current });
          },
        }).then(
          (result) => jobs.set(jobId, { state: "done", manifest: result.ref }),
          (cause: unknown) => {
            const failed = classify(cause);
            jobs.set(jobId, { state: "failed", error: failed.detail, status: failed.status });
          },
        );
        return { jobId };
      }),
    );

    const snapshotStatus = handle(AuthOrchestrationReadScope, (input) =>
      Effect.gen(function* () {
        const jobId = stringField(input, "jobId");
        const job = jobId === null ? undefined : jobs.get(jobId);
        if (job === undefined) return yield* bad("No such snapshot job.", 404);
        if (job.state !== "running" && jobId !== null) jobs.delete(jobId);
        return job;
      }),
    );

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
