import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  decodeDriveManifestRefV1,
  describeDriveSize,
  type DriveManifestRefV1,
} from "@t3tools/ai-os-contracts";

import { GrokT3Error } from "./errors.ts";
import { clearAdapterBoard, createGrokT3Adapter, type AttemptSession } from "./grokT3.ts";
import {
  T3_LAUNCH_DEFAULTS,
  wsT3LocalClient,
  type T3LocalClient,
  type T3ModelCatalog,
  type T3ModelSelection,
} from "./t3Client.ts";

/** Dev-server port. Override with `--origin` when the server picked another one. */
export const LIVE_DRIVER_DEFAULT_ORIGIN = "http://127.0.0.1:13773";

/** Pairing token. Read from the environment so it is not echoed as a process argument. */
export const LIVE_DRIVER_PAIRING_ENV = "T3_PAIRING_TOKEN";

/**
 * Direct Node entry. Package-manager runners print the child command before
 * this process starts, so the token must not be passed through one.
 */
export const LIVE_DRIVER_COMMAND =
  "node --experimental-strip-types packages/ai-os-adapter/scripts/live-driver.ts";

/** Folder tasks started at once by --evaluate-folder unless --concurrency says otherwise. */
export const DEFAULT_FOLDER_CONCURRENCY = 4;

export const LIVE_DRIVER_HELP = `Record one intake on a local T3 server and publish it to /operations.

A loopback origin (localhost, 127.0.0.1, or ::1) needs no pairing token.
For any other origin, set ${LIVE_DRIVER_PAIRING_ENV} to that run's pairing token.
A pairing token is not accepted as an argument.
Run this from the repository root. Do not wrap it in a package-manager runner.

${LIVE_DRIVER_COMMAND} --list-projects
${LIVE_DRIVER_COMMAND} \\
  --origin ${LIVE_DRIVER_DEFAULT_ORIGIN} \\
  --project-id <id> \\
  --title "Tournament page" \\
  --prompt "Update the tournament page schedule."

Omit --project-id to print the ids from GET /api/projects.
Pass --list-projects together with --project-id, --title, and --prompt to list
and launch in one run. Omit --model to use the project's configured model when
the provider offers it, then the server default, then the provider's default or
the first available model. An explicit --model that is not offered is an error
listing the valid models.

Google Drive, for this project only (the server holds the Drive token; files
are read-only copies; Drive must be on for the project):
  --drive <link or id>        Attach a Drive file, or every file under a folder,
                              to this task. Repeat to attach several.
  --drive-search "<text>"     Print numbered Drive matches (names only) to pick
                              from, and stop.
  --drive-search "<text>" --pick 1,3
                              Attach those matches to this task.
  --evaluate-folder inputs    One task per file in the project's Drive inputs
                              folder (all depths), or pass a folder link inside
                              the project's aios/projects/<name>/ folders.
                              --title and --prompt apply to each; the file path
                              is added to the title.
  --concurrency <n>           Folder tasks run at once (default ${DEFAULT_FOLDER_CONCURRENCY}).
The task title shows the Drive total, e.g. "[Drive: 3 files, 1.2 MB]".`;

export class LiveDriverUsageError extends Schema.TaggedError<LiveDriverUsageError>()(
  "LiveDriverUsageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface LiveDriverRequest {
  readonly origin: string;
  readonly pairingToken: string | undefined;
  readonly projectId: string | undefined;
  readonly model: string | undefined;
  readonly title: string | undefined;
  readonly prompt: string | undefined;
  readonly listProjects: boolean;
  /** Drive links or ids to attach. */
  readonly drive?: readonly string[];
  readonly driveSearch?: string | undefined;
  readonly pick?: readonly number[];
  /** A folder link, or "inputs" for the project's Drive inputs folder. */
  readonly evaluateFolder?: string | undefined;
  readonly concurrency?: number | undefined;
}

export interface LiveDriverDependencies {
  readonly client: T3LocalClient;
  readonly clock: () => string;
  readonly write: (line: string) => void;
  readonly sleep: (millis: number) => Effect.Effect<void>;
  readonly readRepoCommit: (workspaceRoot: string) => Promise<string>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

const take = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new LiveDriverUsageError({ detail: `Missing value for ${flag}.\n\n${LIVE_DRIVER_HELP}` });
  }
  return value;
};

const isLiveDriverUsageError = Schema.is(LiveDriverUsageError);

export const parseLiveDriverArgs = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LiveDriverRequest => {
  let origin = LIVE_DRIVER_DEFAULT_ORIGIN;
  const rawToken = env[LIVE_DRIVER_PAIRING_ENV];
  let pairingToken =
    rawToken === undefined || rawToken.trim().length === 0 ? undefined : rawToken.trim();
  let projectId: string | undefined;
  let model: string | undefined;
  let title: string | undefined;
  let prompt: string | undefined;
  let listProjects = false;
  const drive: string[] = [];
  let driveSearch: string | undefined;
  let pick: number[] = [];
  let evaluateFolder: string | undefined;
  let concurrency: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag === "--pairing-token" || flag?.startsWith("--pairing-token=") === true) {
      throw new LiveDriverUsageError({
        detail: `Set ${LIVE_DRIVER_PAIRING_ENV}. A pairing token is not accepted as an argument.\n\n${LIVE_DRIVER_HELP}`,
      });
    }
    switch (flag) {
      case "--help":
      case "-h":
        throw new LiveDriverUsageError({ detail: LIVE_DRIVER_HELP });
      case "--list-projects":
        listProjects = true;
        break;
      case "--origin":
        origin = take(argv, index, flag);
        index += 1;
        break;
      case "--project-id":
        projectId = take(argv, index, flag);
        index += 1;
        break;
      case "--model":
        model = take(argv, index, flag);
        index += 1;
        break;
      case "--title":
        title = take(argv, index, flag);
        index += 1;
        break;
      case "--prompt":
        prompt = take(argv, index, flag);
        index += 1;
        break;
      case "--drive":
        drive.push(take(argv, index, flag));
        index += 1;
        break;
      case "--drive-search":
        driveSearch = take(argv, index, flag);
        index += 1;
        break;
      case "--pick": {
        const raw = take(argv, index, flag);
        index += 1;
        pick = raw.split(",").map((part) => Number(part.trim()));
        if (pick.some((value) => !Number.isInteger(value) || value < 1)) {
          throw new LiveDriverUsageError({
            detail: `--pick takes result numbers such as 1,3.\n\n${LIVE_DRIVER_HELP}`,
          });
        }
        break;
      }
      case "--concurrency": {
        const raw = take(argv, index, flag);
        concurrency = Number(raw);
        if (!/^\d+$/.test(raw) || concurrency < 1) {
          throw new LiveDriverUsageError({
            detail: `--concurrency takes a whole number of tasks, 1 or more.\n\n${LIVE_DRIVER_HELP}`,
          });
        }
        index += 1;
        break;
      }
      case "--evaluate-folder":
        evaluateFolder = take(argv, index, flag);
        index += 1;
        break;
      default:
        throw new LiveDriverUsageError({
          detail: `Unknown argument ${flag ?? ""}.\n\n${LIVE_DRIVER_HELP}`,
        });
    }
  }

  return {
    origin: origin.replace(/\/+$/, ""),
    pairingToken,
    projectId,
    model,
    title,
    prompt,
    listProjects,
    drive,
    driveSearch,
    pick,
    evaluateFolder,
    concurrency,
  };
};

const modelList = (catalog: T3ModelCatalog): string => {
  const parts = catalog.providers.flatMap((provider) =>
    provider.models.length === 0
      ? []
      : [`${provider.instanceId}: ${provider.models.map((model) => model.slug).join(", ")}`],
  );
  return parts.length === 0 ? "(none)" : parts.join("; ");
};

const canonicalModel = (
  catalog: T3ModelCatalog,
  instanceId: string,
  model: string,
): string | undefined => {
  const provider = catalog.providers.find((entry) => entry.instanceId === instanceId);
  const offer = provider?.models.find(
    (entry) => entry.slug === model || entry.aliases.includes(model),
  );
  return offer?.slug;
};

/**
 * Use an explicit `--model` when it is offered. Otherwise the project default,
 * then the server default, when those slugs are actually offered. A configured
 * slug the provider does not list is skipped. Then a model marked default, then
 * the first offered model.
 */
export const resolveDriverModel = (input: {
  readonly requested: string | undefined;
  readonly projectDefault: T3ModelSelection | null;
  readonly catalog: T3ModelCatalog;
}): { readonly instanceId: string; readonly model: string } | { readonly error: string } => {
  const requested = input.requested?.trim() ?? "";
  const listed = modelList(input.catalog);
  const offered = input.catalog.providers.some((provider) => provider.models.length > 0);
  if (!offered) {
    return { error: "The server reported no models for this provider." };
  }
  if (requested.length > 0) {
    const onLaunch = canonicalModel(input.catalog, T3_LAUNCH_DEFAULTS.instanceId, requested);
    if (onLaunch !== undefined) {
      return { instanceId: T3_LAUNCH_DEFAULTS.instanceId, model: onLaunch };
    }
    for (const provider of input.catalog.providers) {
      const slug = canonicalModel(input.catalog, provider.instanceId, requested);
      if (slug !== undefined) return { instanceId: provider.instanceId, model: slug };
    }
    return { error: `Model ${requested} is not available. Valid models: ${listed}.` };
  }
  const fromSelection = (selection: T3ModelSelection | null) => {
    if (selection === null) return undefined;
    const slug = canonicalModel(input.catalog, selection.instanceId, selection.model);
    if (slug === undefined) return undefined;
    return { instanceId: selection.instanceId, model: slug };
  };
  const fromProject = fromSelection(input.projectDefault);
  if (fromProject !== undefined) return fromProject;
  const fromServer = fromSelection(input.catalog.serverDefault);
  if (fromServer !== undefined) return fromServer;
  const providers = [
    ...input.catalog.providers.filter(
      (provider) => provider.instanceId === T3_LAUNCH_DEFAULTS.instanceId,
    ),
    ...input.catalog.providers.filter(
      (provider) => provider.instanceId !== T3_LAUNCH_DEFAULTS.instanceId,
    ),
  ];
  for (const provider of providers) {
    const marked = provider.models.find((model) => model.isDefault);
    if (marked !== undefined) return { instanceId: provider.instanceId, model: marked.slug };
  }
  for (const provider of providers) {
    const first = provider.models[0];
    if (first !== undefined) return { instanceId: provider.instanceId, model: first.slug };
  }
  return { error: `Pass --model. Valid models: ${listed}.` };
};

/** Stable task id for one title at one instant. Contract ids cannot contain spaces. */
export const liveTaskId = (title: string, stamp: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const compact = stamp
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/i, "Z")
    .toLowerCase();
  return `live-${slug.length > 0 ? slug : "task"}-${compact}`.slice(0, 128);
};

const phaseLabel = (session: AttemptSession): string =>
  session.state.phase === "executing"
    ? `executing ${session.state.run.progress?.status ?? "starting"}`
    : session.state.phase;

interface DriveListedFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly path?: string;
  readonly webViewLink?: string | null;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const filesOf = (value: unknown): DriveListedFile[] =>
  isRecord(value) && Array.isArray(value.files)
    ? value.files.filter(
        (file): file is DriveListedFile =>
          isRecord(file) && typeof file.id === "string" && typeof file.name === "string",
      )
    : [];

const unreadable = (what: string) =>
  new GrokT3Error({
    reason: "t3_rejected",
    detail: `The server returned an unreadable Drive ${what}.`,
  });

const driveClient = (client: T3LocalClient) =>
  client.driveCall === undefined
    ? Effect.fail(
        new LiveDriverUsageError({ detail: "This T3 client cannot reach the Drive routes." }),
      )
    : Effect.succeed(client.driveCall);

const sizeLabel = (bytes: number | null) =>
  bytes === null ? "" : ` (${describeDriveSize(1, bytes).replace(/^1 file, /, "")})`;

/**
 * Snapshot the Drive refs into the project worktree on the server, wait for
 * it, and check it is in place. Returns the manifest for the context package.
 */
const snapshotDrive = (
  deps: LiveDriverDependencies,
  projectId: string,
  taskId: string,
  refs: readonly string[],
) =>
  Effect.gen(function* () {
    const call = yield* driveClient(deps.client);
    const started = yield* call("snapshot", { projectId, taskId, refs });
    if (!isRecord(started) || typeof started.jobId !== "string") {
      return yield* unreadable("snapshot job");
    }
    let lastDone = -1;
    const interval = deps.pollIntervalMs ?? 1_000;
    for (;;) {
      const status = yield* call("snapshot/status", { jobId: started.jobId });
      if (!isRecord(status)) return yield* unreadable("snapshot status");
      if (status.state === "done") {
        const manifest = yield* decodeDriveManifestRefV1(status.manifest).pipe(
          Effect.mapError(() => unreadable("manifest")),
        );
        const check = yield* call("verify", { projectId, manifest });
        const problem = isRecord(check) ? check.problem : "unreadable check";
        if (typeof problem === "string") {
          return yield* new GrokT3Error({ reason: "invalid_task", detail: problem });
        }
        return manifest;
      }
      if (status.state === "failed") {
        return yield* new GrokT3Error({
          reason: status.status === 401 ? "unauthenticated" : "t3_rejected",
          detail: typeof status.error === "string" ? status.error : "Drive snapshot failed.",
        });
      }
      if (typeof status.done === "number" && status.done !== lastDone) {
        lastDone = status.done;
        deps.write(
          `drive ${status.done}/${typeof status.total === "number" ? status.total : "?"}${typeof status.current === "string" ? ` ${status.current}` : ""}`,
        );
      }
      yield* deps.sleep(interval);
    }
  });

/**
 * Record, launch, and poll one intake.
 *
 * Board updates go through `client.publishBoard`, which POSTs to the T3
 * server's `/api/ai-os/board`. That is the hub `/operations` reads.
 */
export const runLiveDriver = (
  request: LiveDriverRequest,
  deps: LiveDriverDependencies,
): Effect.Effect<void, GrokT3Error | LiveDriverUsageError> =>
  Effect.gen(function* () {
    const picked: string[] = [];
    if (request.driveSearch !== undefined) {
      // Search only picks files to attach to this project's task.
      if (request.projectId === undefined) {
        return yield* new LiveDriverUsageError({
          detail:
            "--drive-search needs --project-id: Drive files are attached to a project's task.",
        });
      }
      const call = yield* driveClient(deps.client);
      const found = filesOf(
        yield* call("search", { projectId: request.projectId, query: request.driveSearch }),
      );
      if ((request.pick ?? []).length === 0) {
        if (found.length === 0) deps.write("No Drive matches.");
        found.forEach((file, index) => {
          deps.write(
            `${index + 1}\t${file.name}${file.mimeType === FOLDER_MIME ? " (folder)" : sizeLabel(file.size)}\t${file.id}`,
          );
        });
        return;
      }
      for (const number of request.pick ?? []) {
        const file = found[number - 1];
        if (file === undefined) {
          return yield* new LiveDriverUsageError({
            detail: `--pick ${number}: the search returned ${found.length} matches.`,
          });
        }
        picked.push(file.id);
      }
    } else if ((request.pick ?? []).length > 0) {
      return yield* new LiveDriverUsageError({ detail: "--pick needs --drive-search." });
    }

    const projects = yield* deps.client.listProjectIds();
    const title = request.title?.trim() ?? "";
    const prompt = request.prompt?.trim() ?? "";
    const launching = request.projectId !== undefined && title.length > 0 && prompt.length > 0;
    if (request.listProjects || request.projectId === undefined) {
      if (projects.length === 0) deps.write("No projects.");
      for (const project of projects) deps.write(`${project.id}\t${project.title}`);
      if (!launching) {
        if (request.listProjects) return;
        return yield* new LiveDriverUsageError({
          detail: "Pass --project-id. The ids above are the projects on this server.",
        });
      }
    }

    if (title.length === 0 || prompt.length === 0) {
      return yield* new LiveDriverUsageError({ detail: "Pass --title and --prompt." });
    }

    const project = projects.find((entry) => entry.id === request.projectId);
    if (project === undefined) {
      for (const entry of projects) deps.write(`${entry.id}\t${entry.title}`);
      return yield* new LiveDriverUsageError({ detail: `No project ${request.projectId}.` });
    }

    const repoCommit = yield* Effect.tryPromise({
      try: () => deps.readRepoCommit(project.workspaceRoot),
      catch: (cause) =>
        new GrokT3Error({
          reason: "invalid_task",
          detail:
            typeof cause === "object" &&
            cause !== null &&
            "message" in cause &&
            typeof cause.message === "string" &&
            cause.message.length > 0
              ? cause.message
              : `Could not read git HEAD in ${project.workspaceRoot}.`,
        }),
    });
    const catalog = yield* deps.client.listProviderModels();
    const resolved = resolveDriverModel({
      requested: request.model,
      projectDefault: project.defaultModel,
      catalog,
    });
    if ("error" in resolved) {
      return yield* new LiveDriverUsageError({ detail: resolved.error });
    }

    // One board for this run: folder tasks run side by side and all stay listed.
    clearAdapterBoard();
    const adapter = createGrokT3Adapter({
      client: deps.client,
      clock: deps.clock,
      model: resolved.model,
      instanceId: resolved.instanceId,
    });
    const runOne = (
      taskTitle: string,
      idSeed: string,
      refs: readonly string[],
      write: (line: string) => void = deps.write,
    ) =>
      Effect.gen(function* () {
        const stamp = deps.clock();
        const taskId = liveTaskId(idSeed, stamp);
        let driveManifest: DriveManifestRefV1 | undefined;
        let shownTitle = taskTitle;
        if (refs.length > 0) {
          driveManifest = yield* snapshotDrive({ ...deps, write }, project.id, taskId, refs);
          const size = describeDriveSize(driveManifest.totalFiles, driveManifest.totalBytes);
          shownTitle = `${taskTitle} [Drive: ${size}]`;
          write(
            `drive snapshot ${driveManifest.root}: ${size}${driveManifest.failedFiles > 0 ? `, ${driveManifest.failedFiles} without text` : ""}`,
          );
        }
        const recorded = yield* adapter.record({
          taskId,
          title: shownTitle,
          intake: {
            version: "v1",
            workspaceId: "personal",
            projectId: project.id,
            request: prompt,
            constraints: [],
            acceptanceCriteria: [prompt],
            authorization: { kind: "explicit", scope: project.id },
            originatingConversationId: "live-driver",
          },
          context: {
            requirements: prompt,
            memoryVersions: [],
            repoCommit,
            authorizationScope: project.id,
            createdAt: stamp,
            ...(driveManifest === undefined ? {} : { driveManifest }),
          },
        });
        const started = yield* adapter.launch(recorded.taskId);
        write(`task ${started.taskId}`);
        if (started.threadId !== null) write(`thread ${started.threadId}`);

        const threadId = started.threadId;
        if (threadId === null) {
          return yield* new GrokT3Error({
            reason: "not_started",
            detail: "Launch did not return a thread.",
          });
        }

        let lastText = "";
        let lastLabel = "";
        const limit = deps.maxPolls ?? 600;
        const interval = deps.pollIntervalMs ?? 1_000;
        for (let attempt = 0; attempt < limit; attempt += 1) {
          const view = yield* deps.client.read(threadId);
          if (view.text !== null && view.text !== lastText) {
            write(view.text);
            lastText = view.text;
          }
          const session = yield* adapter.observe(recorded.taskId);
          const label = phaseLabel(session);
          if (label !== lastLabel) {
            write(label);
            lastLabel = label;
          }
          // Recovery stays with this driver. Leaving here is what let a board pause
          // drop the owner, so a later resume had nobody watching the thread.
          if (session.state.phase !== "executing" && session.state.phase !== "recovery_pending") {
            return;
          }
          yield* deps.sleep(interval);
        }
        write("still executing");
      });

    const shared = [...(request.drive ?? []), ...picked];
    if (request.evaluateFolder !== undefined) {
      const call = yield* driveClient(deps.client);
      const folder = request.evaluateFolder.trim();
      // "inputs": the server uses the project's Drive inputs folder.
      const listing = yield* call("list", {
        projectId: project.id,
        ...(folder === "inputs" ? {} : { ref: folder }),
      });
      const root = isRecord(listing) && isRecord(listing.root) ? listing.root : null;
      if (root === null) return yield* unreadable("folder listing");
      if (root.mimeType !== FOLDER_MIME) {
        return yield* new LiveDriverUsageError({
          detail: "--evaluate-folder needs a folder. Use --drive for a single file.",
        });
      }
      const files = filesOf(listing);
      const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
      const concurrency = request.concurrency ?? DEFAULT_FOLDER_CONCURRENCY;
      deps.write(
        `evaluating ${describeDriveSize(files.length, totalBytes)} under ${String(root.name)}, one task each, ${concurrency} at a time`,
      );
      const results = yield* Effect.forEach(
        files.entries(),
        ([index, file]) => {
          const path = file.path ?? file.name;
          const tag = `[${index + 1}/${files.length} ${path}]`;
          const write = (line: string) => deps.write(`${tag} ${line}`);
          return runOne(
            `${title}: ${path}`,
            `${title}-${index + 1}`,
            [file.id, ...shared],
            write,
          ).pipe(
            Effect.tapError((error) => Effect.sync(() => write(`failed: ${error.message}`))),
            Effect.result,
          );
        },
        { concurrency },
      );
      const failed = results.filter((result) => result._tag === "Failure").length;
      deps.write(
        `evaluated ${files.length - failed}/${files.length} files${failed > 0 ? `, ${failed} failed` : ""}`,
      );
      if (failed > 0) {
        return yield* new GrokT3Error({
          reason: "invalid_task",
          detail: `${failed} of ${files.length} folder tasks failed; see the lines marked failed.`,
        });
      }
      return;
    }
    yield* runOne(title, title, shared);
  });

export const isLoopbackDriverOrigin = (origin: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
};

export const runLiveDriverCli = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  readRepoCommit: (workspaceRoot: string) => Promise<string>,
): Promise<number> => {
  let request: LiveDriverRequest;
  try {
    request = parseLiveDriverArgs(argv, env);
  } catch (error) {
    if (isLiveDriverUsageError(error)) {
      const help = error.message === LIVE_DRIVER_HELP;
      const stream = help ? process.stdout : process.stderr;
      stream.write(`${error.message}\n`);
      return Promise.resolve(help ? 0 : 1);
    }
    throw error;
  }

  if (request.pairingToken === undefined && !isLoopbackDriverOrigin(request.origin)) {
    process.stderr.write(`Set ${LIVE_DRIVER_PAIRING_ENV}.\n\n${LIVE_DRIVER_HELP}\n`);
    return Promise.resolve(1);
  }

  return Effect.runPromise(
    runLiveDriver(request, {
      client: wsT3LocalClient({
        origin: request.origin,
        ...(request.pairingToken === undefined ? {} : { pairingToken: request.pairingToken }),
      }),
      clock: () => DateTime.formatIso(DateTime.nowUnsafe()),
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
      sleep: (millis) => Effect.sleep(millis),
      readRepoCommit,
    }).pipe(
      Effect.as(0),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`);
          return 1;
        }),
      ),
    ),
  );
};
