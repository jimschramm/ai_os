import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GrokT3Error } from "./errors.ts";
import { clearAdapterBoard, createGrokT3Adapter, type AttemptSession } from "./grokT3.ts";
import { wsT3LocalClient, type T3LocalClient } from "./t3Client.ts";

/** Dev-server port. Override with `--origin` when the server picked another one. */
export const LIVE_DRIVER_DEFAULT_ORIGIN = "http://127.0.0.1:13773";

/** Read by the CLI when `--pairing-token` is omitted. */
export const LIVE_DRIVER_PAIRING_ENV = "T3_PAIRING_TOKEN";

const DEFAULT_MODEL = "gpt-5.4";

export const LIVE_DRIVER_HELP = `Record one intake on a local T3 server and publish it to /operations.

vp run --filter @t3tools/ai-os-adapter live-driver -- --list-projects --pairing-token <token>
vp run --filter @t3tools/ai-os-adapter live-driver -- \\
  --origin ${LIVE_DRIVER_DEFAULT_ORIGIN} \\
  --pairing-token <token> \\
  --project-id <id> \\
  --model ${DEFAULT_MODEL} \\
  --title "Tournament page" \\
  --prompt "Update the tournament page schedule."

--pairing-token may be omitted when ${LIVE_DRIVER_PAIRING_ENV} is set.
Omit --project-id to print the ids from GET /api/projects.`;

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
  readonly pairingToken: string;
  readonly projectId: string | undefined;
  readonly model: string;
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
  let pairingToken = env[LIVE_DRIVER_PAIRING_ENV];
  let projectId: string | undefined;
  let model = DEFAULT_MODEL;
  let title: string | undefined;
  let prompt: string | undefined;
  let listProjects = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
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
      case "--pairing-token":
        pairingToken = take(argv, index, flag);
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

  if (pairingToken === undefined || pairingToken.trim().length === 0) {
    throw new LiveDriverUsageError({
      detail: `Pass --pairing-token or set ${LIVE_DRIVER_PAIRING_ENV}.\n\n${LIVE_DRIVER_HELP}`,
    });
  }

  return {
    origin: origin.replace(/\/+$/, ""),
    pairingToken: pairingToken.trim(),
    projectId,
    model,
    title,
    prompt,
    listProjects,
  };
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
    if (request.listProjects || request.projectId === undefined) {
      if (projects.length === 0) deps.write("No projects.");
      for (const project of projects) deps.write(`${project.id}\t${project.title}`);
      if (request.listProjects) return;
      return yield* new LiveDriverUsageError({
        detail: "Pass --project-id. The ids above are the projects on this server.",
      });
    }

    const title = request.title?.trim() ?? "";
    const prompt = request.prompt?.trim() ?? "";
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
    const stamp = deps.clock();
    const taskId = liveTaskId(title, stamp);
    clearAdapterBoard();
    const adapter = createGrokT3Adapter({
      client: deps.client,
      clock: deps.clock,
      model: request.model,
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

  return Effect.runPromise(
    runLiveDriver(request, {
      client: wsT3LocalClient({ origin: request.origin, pairingToken: request.pairingToken }),
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
