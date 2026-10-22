import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
listing the valid models.`;

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
    const stamp = deps.clock();
    const taskId = liveTaskId(title, stamp);
    clearAdapterBoard();
    const adapter = createGrokT3Adapter({
      client: deps.client,
      clock: deps.clock,
      model: resolved.model,
      instanceId: resolved.instanceId,
    });
    const recorded = yield* adapter.record({
      taskId,
      title,
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
      },
    });
    const started = yield* adapter.launch(recorded.taskId);
    deps.write(`task ${started.taskId}`);
    if (started.threadId !== null) deps.write(`thread ${started.threadId}`);

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
        deps.write(view.text);
        lastText = view.text;
      }
      const session = yield* adapter.observe(recorded.taskId);
      const label = phaseLabel(session);
      if (label !== lastLabel) {
        deps.write(label);
        lastLabel = label;
      }
      if (session.state.phase !== "executing") return;
      yield* deps.sleep(interval);
    }
    deps.write("still executing");
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
