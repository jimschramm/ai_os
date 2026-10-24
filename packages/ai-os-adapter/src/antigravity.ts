// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This runner spawns the Antigravity CLI and arms a SIGKILL watchdog.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  canonicalGitSha,
  parseModelRef,
  sameModelName,
  type ContextPackageSnapshotV1,
  type Intake,
} from "@t3tools/ai-os-contracts";

import { renderPrompt as renderTaskPrompt } from "./grokT3.ts";

export interface AntigravityModel {
  readonly slug: string;
  readonly label: string;
}

export interface AntigravityCatalog {
  readonly source: "cli" | "unverified";
  readonly models: readonly AntigravityModel[];
  readonly detail: string | null;
}

export interface AdvisoryFindingDraft {
  readonly commit: string;
  readonly files: readonly string[];
  readonly evidence: string;
  readonly suggestedAction: string;
}

export interface AdvisorySuccess {
  readonly status: "completed" | "model_mismatch";
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly unverified: boolean;
  readonly commit: string;
  readonly summary: string;
  readonly findings: readonly AdvisoryFindingDraft[];
  readonly progressNote: string;
  readonly conversationId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly sourcePath: string;
  readonly scratchPath: string;
  readonly detail: string | null;
}

export interface AdvisoryStop {
  readonly status: "unavailable" | "failed" | "canceled";
  readonly detail: string;
  readonly models: readonly string[];
  readonly requestedModel: string | null;
  readonly actualModel: string | null;
}

export type AdvisoryExecution = AdvisorySuccess | AdvisoryStop;

export interface SpawnedCli {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  readonly interrupt: () => void;
  readonly exited: Promise<number | null>;
}

export interface CliSpawner {
  readonly spawn: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }) => SpawnedCli;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  readonly run: (args: readonly string[], cwd: string) => Promise<GitResult>;
}

const ANTHROPIC = /claude|anthropic/i;
const TIME_LIMIT = /^\d+(?:\.\d+)?(?:s|m|h)$/;
const KEPT_ENV = [
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "TERM",
] as const;

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
          suggestedAction: { type: "string" },
        },
        required: ["files", "evidence", "suggestedAction"],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

export const isAnthropicModel = (model: AntigravityModel): boolean =>
  ANTHROPIC.test(model.slug) || ANTHROPIC.test(model.label);

/** `agy models` prints `slug<spaces>label`. Anthropic rows are dropped. */
export const parseModelList = (text: string): readonly AntigravityModel[] => {
  const models: AntigravityModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const matched = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+(\S.*))?$/.exec(trimmed);
    if (matched === null || matched[1] === undefined) continue;
    const slug = matched[1].toLowerCase();
    if (parseModelRef(slug) === null) continue;
    const model = { slug, label: (matched[2] ?? matched[1]).trim() };
    if (!isAnthropicModel(model)) models.push(model);
  }
  return models;
};

const definedEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
};

/**
 * The review process gets a fresh HOME so it does not rewrite Jim's CLI
 * settings. Keyring variables stay so an existing Google sign-in can be read.
 * Tokens and deploy credentials are not copied.
 */
export const advisoryEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
  home: string,
  scratch: string,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of KEPT_ENV) {
    const value = parent[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  env.HOME = home;
  env.TMPDIR = scratch;
  env.GIT_CONFIG_GLOBAL = path.join(home, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  return env;
};

export const reviewArguments = (input: {
  readonly prompt: string;
  readonly model: string;
  readonly scratch: string;
  readonly schemaPath: string;
  readonly timeLimit?: string;
}): readonly string[] => {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--model",
    input.model,
    "--sandbox",
    "--add-dir",
    input.scratch,
    "--json-schema",
    input.schemaPath,
  ];
  if (input.timeLimit !== undefined) args.push("--print-timeout", input.timeLimit);
  return args;
};

const slugOf = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const slug = value.trim().toLowerCase();
  return parseModelRef(slug)?.model ?? null;
};

export const resolveModelChoice = (input: {
  readonly discovered: readonly AntigravityModel[] | null;
  readonly requested: string | undefined;
  readonly configured: string | undefined;
}):
  | { readonly ok: true; readonly slug: string; readonly unverified: boolean }
  | { readonly ok: false; readonly detail: string; readonly models: readonly string[] } => {
  const requested = slugOf(input.requested);
  const configured = slugOf(input.configured);
  const reject = (detail: string, models: readonly string[]) => ({
    ok: false as const,
    detail,
    models,
  });
  if (input.requested !== undefined && requested === null) {
    return reject(`"${input.requested}" is not a model slug.`, []);
  }
  if (input.configured !== undefined && input.requested === undefined && configured === null) {
    return reject(`The configured model "${input.configured}" is not a model slug.`, []);
  }
  if (requested !== null && isAnthropicModel({ slug: requested, label: requested })) {
    return reject("Anthropic models are excluded. Choose another model.", []);
  }
  if (
    requested === null &&
    configured !== null &&
    isAnthropicModel({ slug: configured, label: configured })
  ) {
    return reject("The configured model is an Anthropic model, which is excluded.", []);
  }
  if (input.discovered !== null) {
    const models = input.discovered.map((model) => model.slug);
    if (requested === null) {
      const listed = models.length === 0 ? "The CLI listed no usable models." : models.join(", ");
      return reject(`Choose an Antigravity model. ${listed}`, models);
    }
    if (!models.includes(requested)) {
      const listed = models.length === 0 ? "none" : models.join(", ");
      return reject(`${requested} is not available from the CLI. Choose one of: ${listed}`, models);
    }
    return { ok: true, slug: requested, unverified: false };
  }
  if (requested !== null) return { ok: true, slug: requested, unverified: true };
  if (configured !== null) return { ok: true, slug: configured, unverified: true };
  return reject(
    "Antigravity could not list models, and no model is configured. Set AI_OS_ANTIGRAVITY_MODEL or choose one for this task. That choice stays unverified until the CLI lists models.",
    [],
  );
};

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;

const readFindings = (
  value: unknown,
  commit: string,
): { readonly summary: string; readonly findings: readonly AdvisoryFindingDraft[] } | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const summary = textOf(record.summary)?.trim() ?? "";
  if (summary.length === 0 || summary.length > 8_000 || !Array.isArray(record.findings)) {
    return null;
  }
  const findings: AdvisoryFindingDraft[] = [];
  for (const item of record.findings) {
    if (typeof item !== "object" || item === null) return null;
    const finding = item as Record<string, unknown>;
    const evidence = textOf(finding.evidence)?.trim() ?? "";
    const suggestedAction = textOf(finding.suggestedAction)?.trim() ?? "";
    if (
      evidence.length === 0 ||
      evidence.length > 8_000 ||
      suggestedAction.length === 0 ||
      suggestedAction.length > 8_000 ||
      !Array.isArray(finding.files)
    ) {
      return null;
    }
    const files = finding.files.filter(
      (file): file is string =>
        typeof file === "string" &&
        file.trim() === file &&
        file.length > 0 &&
        file.length <= 1_024 &&
        !/[\r\n]/.test(file),
    );
    if (files.length === 0 || files.length !== finding.files.length) return null;
    findings.push({ commit, files, evidence, suggestedAction });
  }
  return { summary, findings };
};

export interface ParsedCliRun {
  readonly model: string | null;
  readonly status: string | null;
  readonly error: string | null;
  readonly response: string;
  readonly structured: ReturnType<typeof readFindings>;
  readonly conversationId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly progressNote: string;
}

export const parseCliRun = (lines: readonly string[], commit: string): ParsedCliRun => {
  let model: string | null = null;
  let status: string | null = null;
  let error: string | null = null;
  let response = "";
  let structured: ReturnType<typeof readFindings> = null;
  let conversationId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let progressNote = "Advisory review is running.";
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record.event === "init" && typeof record.init === "object" && record.init !== null) {
      const reported = textOf((record.init as Record<string, unknown>).model);
      if (reported !== null && parseModelRef(reported) !== null)
        model = reported.trim().toLowerCase();
    }
    if (
      record.event === "step_update" &&
      typeof record.step_update === "object" &&
      record.step_update !== null
    ) {
      const step = record.step_update as Record<string, unknown>;
      const tool = textOf(step.tool_name);
      const delta = textOf(step.text_delta)?.trim();
      if (tool !== null) progressNote = `Tool ${tool}`.slice(0, 8_000);
      else if (delta !== undefined && delta.length > 0) progressNote = delta.slice(0, 8_000);
    }
    if (record.event === "result" && typeof record.result === "object" && record.result !== null) {
      const result = record.result as Record<string, unknown>;
      status = textOf(result.status);
      error = textOf(result.error);
      response = textOf(result.response) ?? "";
      conversationId = textOf(result.conversation_id);
      structured = readFindings(result.structured_output, commit);
      if (typeof result.usage === "object" && result.usage !== null) {
        const usage = result.usage as Record<string, unknown>;
        inputTokens = countOf(usage.input_tokens);
        outputTokens = countOf(usage.output_tokens);
      }
    }
  }
  return {
    model,
    status,
    error,
    response,
    structured,
    conversationId,
    inputTokens,
    outputTokens,
    progressNote,
  };
};

const linesFrom = async function* (stream: Readable): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of stream) {
    pending += String(chunk);
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      yield pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  if (pending.length > 0) yield pending;
};

const emptyLines = async function* (): AsyncGenerator<string> {};

export const nodeCliSpawner: CliSpawner = {
  spawn: (input) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const interrupt = () => {
      child.kill("SIGINT");
      // SIGINT is the documented headless interrupt. SIGKILL follows if it stays up.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve(code);
      });
    });
    return {
      stdout: child.stdout === null ? emptyLines() : linesFrom(child.stdout),
      stderr: child.stderr === null ? emptyLines() : linesFrom(child.stderr),
      interrupt,
      exited,
    };
  },
};

const defaultGit: GitRunner = {
  run: (args, cwd) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
        const code =
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    }),
};

const makeReadOnly = async (root: string): Promise<void> => {
  const info = await stat(root);
  await chmod(root, info.isDirectory() ? 0o555 : 0o444);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await makeReadOnly(path.join(root, entry.name));
  }
};

const gitFailure = (result: GitResult, command: string): string => {
  const detail = (result.stderr || result.stdout).trim();
  return detail.length > 0 ? `git ${command} failed: ${detail}` : `git ${command} failed.`;
};

const drain = async (lines: AsyncIterable<string>, into: string[]): Promise<void> => {
  for await (const line of lines) into.push(line);
};

const collect = async (
  spawned: SpawnedCli,
  signal: AbortSignal | undefined,
): Promise<{
  readonly stdout: string[];
  readonly stderr: string;
  readonly code: number | null;
}> => {
  if (signal?.aborted) spawned.interrupt();
  const onAbort = () => spawned.interrupt();
  signal?.addEventListener("abort", onAbort, { once: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await Promise.all([
      spawned.exited,
      drain(spawned.stdout, stdout),
      drain(spawned.stderr, stderr),
    ]).then(([exitCode]) => exitCode);
    return { stdout, stderr: stderr.join("\n"), code };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

export const listAntigravityModels = async (input: {
  readonly command?: string;
  readonly spawner?: CliSpawner;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configuredModel?: string | undefined;
}): Promise<AntigravityCatalog> => {
  const spawner = input.spawner ?? nodeCliSpawner;
  const cwd = input.cwd ?? process.cwd();
  const env = definedEnv(input.env ?? process.env);
  try {
    const spawned = spawner.spawn({
      command: input.command ?? "agy",
      args: ["models"],
      cwd,
      env,
    });
    const collected = await collect(spawned, undefined);
    if (collected.code !== 0 || collected.stdout.join("\n").trim().length === 0) {
      const configured = slugOf(input.configuredModel);
      return {
        source: "unverified",
        models:
          configured === null || isAnthropicModel({ slug: configured, label: configured })
            ? []
            : [{ slug: configured, label: configured }],
        detail:
          collected.stderr.trim() ||
          "The Antigravity CLI did not list models. A configured choice is unverified.",
      };
    }
    const models = parseModelList(collected.stdout.join("\n"));
    return {
      source: "cli",
      models,
      detail:
        models.length === 0
          ? "The CLI listed no usable models after Anthropic models were excluded."
          : null,
    };
  } catch (cause) {
    const configured = slugOf(input.configuredModel);
    return {
      source: "unverified",
      models:
        configured === null || isAnthropicModel({ slug: configured, label: configured })
          ? []
          : [{ slug: configured, label: configured }],
      detail: cause instanceof Error ? cause.message : "The Antigravity CLI could not be started.",
    };
  }
};

export const advisoryUsage = (input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}): readonly Record<string, unknown>[] => {
  const model = input.actualModel ?? input.requestedModel;
  const attribution = {
    projectId: input.projectId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    agentId: input.agentId,
    platform: "local",
    provider: "antigravity",
    model,
  };
  const unknown = (reason: string) => ({ kind: "unknown", reason, attribution });
  if (input.inputTokens === null || input.outputTokens === null) {
    return [unknown("Antigravity did not report token counts or subscription quota for this run.")];
  }
  return [
    {
      kind: "reported_tokens",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      attribution,
    },
    unknown(
      "Antigravity's headless result reports token counts and does not report subscription quota.",
    ),
  ];
};

const stop = (
  status: AdvisoryStop["status"],
  detail: string,
  models: readonly string[] = [],
  requestedModel: string | null = null,
  actualModel: string | null = null,
): AdvisoryStop => ({ status, detail, models, requestedModel, actualModel });

export const runAdvisoryReview = async (input: {
  readonly repoRoot: string;
  readonly isolationRoot: string;
  readonly context: ContextPackageSnapshotV1;
  readonly intake: Intake;
  readonly requestedModel: string | undefined;
  readonly configuredModel: string | undefined;
  readonly timeLimit?: string;
  readonly signal?: AbortSignal;
  readonly command?: string;
  readonly spawner?: CliSpawner;
  readonly git?: GitRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<AdvisoryExecution> => {
  const commit = canonicalGitSha(input.context.repoCommit);
  if (commit === null) return stop("failed", "The context package needs a full commit SHA.");
  if (input.timeLimit !== undefined && !TIME_LIMIT.test(input.timeLimit)) {
    return stop("failed", `The time limit "${input.timeLimit}" is not a duration like 15m.`);
  }
  const parent = input.env ?? process.env;
  const command = input.command ?? "agy";
  const spawner = input.spawner ?? nodeCliSpawner;
  const catalog = await listAntigravityModels({
    command,
    spawner,
    cwd: input.repoRoot,
    env: parent,
    ...(input.configuredModel === undefined ? {} : { configuredModel: input.configuredModel }),
  });
  const choice = resolveModelChoice({
    discovered: catalog.source === "cli" ? catalog.models : null,
    requested: input.requestedModel,
    configured: input.configuredModel,
  });
  if (!choice.ok)
    return stop("unavailable", choice.detail, choice.models, slugOf(input.requestedModel));
  if (input.signal?.aborted) return stop("canceled", "The review was canceled.", [], choice.slug);

  const git = input.git ?? defaultGit;
  const source = path.join(input.isolationRoot, "source");
  const scratch = path.join(input.isolationRoot, "scratch");
  const home = path.join(input.isolationRoot, "home");
  const verified = await git.run(["rev-parse", "--verify", `${commit}^{commit}`], input.repoRoot);
  if (verified.code !== 0) return stop("failed", gitFailure(verified, "rev-parse"));
  await mkdir(input.isolationRoot, { recursive: true });
  const added = await git.run(["worktree", "add", "--detach", source, commit], input.repoRoot);
  if (added.code !== 0) return stop("failed", gitFailure(added, "worktree add"));
  const head = await git.run(["rev-parse", "HEAD"], source);
  const checkedOut = canonicalGitSha(head.stdout);
  if (head.code !== 0 || checkedOut !== commit) {
    return stop(
      "failed",
      `The workspace is at ${head.stdout.trim() || "an unknown commit"}, not ${commit}.`,
    );
  }
  await makeReadOnly(source);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const settings = {
    toolPermission: "request-review",
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    permissions: {
      allow: [
        `read_file(${source})`,
        `write_file(${scratch})`,
        "command(npm test)",
        "command(npm run test)",
        "command(pnpm test)",
        "command(pnpm run test)",
        "command(vp test)",
      ],
      deny: [`write_file(${source})`, "command(git push)", "command(git merge)"],
    },
  };
  const settingsDir = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(path.join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2));
  await writeFile(path.join(home, "gitconfig"), "");
  const schemaPath = path.join(home, "findings.schema.json");
  await writeFile(schemaPath, JSON.stringify(FINDINGS_SCHEMA));
  const prompt = [
    "Advisory repository review. Read the source. Do not merge, push, or deploy.",
    "The source tree is read-only. Put tests only in the scratch directory.",
    `Scratch: ${scratch}`,
    "Return findings in the required schema. Each finding names files, the evidence, and a suggested action.",
    "",
    renderTaskPrompt(input.intake, input.context),
  ].join("\n");
  const args = reviewArguments({
    prompt,
    model: choice.slug,
    scratch,
    schemaPath,
    ...(input.timeLimit === undefined ? {} : { timeLimit: input.timeLimit }),
  });
  let spawned: SpawnedCli;
  try {
    spawned = spawner.spawn({
      command,
      args,
      cwd: source,
      env: advisoryEnvironment(parent, home, scratch),
    });
  } catch (cause) {
    const detail =
      cause instanceof Error ? cause.message : "The Antigravity CLI could not be started.";
    return stop("failed", detail, [], choice.slug);
  }
  const collected = await collect(spawned, input.signal);
  if (input.signal?.aborted) {
    return stop("canceled", "The review was canceled.", [], choice.slug);
  }
  const parsed = parseCliRun(collected.stdout, commit);
  const requestedModel = choice.slug;
  const actualModel = parsed.model;
  const base = {
    requestedModel,
    actualModel,
    unverified: choice.unverified,
    commit,
    summary: parsed.structured?.summary ?? "",
    findings: parsed.structured?.findings ?? [],
    progressNote: parsed.progressNote,
    conversationId: parsed.conversationId,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    sourcePath: source,
    scratchPath: scratch,
  };
  if (parsed.status === "CANCELED" || parsed.status === "INTERRUPTED") {
    return stop(
      "canceled",
      parsed.error ?? "The review was canceled.",
      [],
      requestedModel,
      actualModel,
    );
  }
  if (parsed.status === "ERROR" || (parsed.status === null && collected.code !== 0)) {
    const detail = parsed.error ?? (collected.stderr.trim() || "The Antigravity CLI failed.");
    const unavailable = /invalid model selection|not recognized as a known model/i.test(detail);
    return stop(
      unavailable ? "unavailable" : "failed",
      detail,
      catalog.models.map((model) => model.slug),
      requestedModel,
      actualModel,
    );
  }
  if (parsed.structured === null) {
    const excerpt = parsed.response.trim().slice(0, 500);
    return stop(
      "failed",
      excerpt.length > 0
        ? `The review did not return structured findings. ${excerpt}`
        : "The review did not return structured findings.",
      [],
      requestedModel,
      actualModel,
    );
  }
  if (actualModel !== null && !sameModelName(actualModel, requestedModel)) {
    return {
      ...base,
      status: "model_mismatch",
      detail: `Antigravity ran ${actualModel}, not the requested ${requestedModel}. Choose again. Nothing was substituted.`,
    };
  }
  return { ...base, status: "completed", detail: null };
};
