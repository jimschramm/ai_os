// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assignmentExample, intakeV2Example } from "@t3tools/ai-os-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advisoryEnvironment,
  advisoryUsage,
  listAntigravityModels,
  parseCliRun,
  parseModelList,
  resolveModelChoice,
  reviewArguments,
  runAdvisoryReview,
  type CliSpawner,
  type SpawnedCli,
} from "./antigravity.ts";
import { defaultRoleModelsAreIndependent } from "./workerRoles.ts";

const lines = (text: string): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    if (text.length === 0) return;
    for (const line of text.split("\n")) yield line;
  },
});

const finished = (stdout: string, code = 0): SpawnedCli => ({
  stdout: lines(stdout),
  stderr: lines(""),
  interrupt: () => undefined,
  exited: Promise.resolve(code),
});

const git = (args: readonly string[], cwd: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
      { cwd },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()));
        else resolve(stdout);
      },
    );
  });

const allowCleanup = (root: string) =>
  new Promise<void>((resolve) => {
    execFile("chmod", ["-R", "u+w", root], () => resolve());
  });

const withRepo = async <T>(
  run: (input: { readonly repo: string; readonly sha: string }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-review-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  try {
    await git(["init"], repo);
    await writeFile(path.join(repo, "README.md"), "schedule\n");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "schedule"], repo);
    const sha = (await git(["rev-parse", "HEAD"], repo)).trim();
    return await run({ repo, sha });
  } finally {
    await allowCleanup(root);
    await rm(root, { recursive: true, force: true });
  }
};

const catalog = `gemini-4-argon-high  Gemini 4 Argon High
claude-opus-4  Claude Opus
`;

const successResult = (model: string) =>
  [
    JSON.stringify({ event: "init", init: { model } }),
    JSON.stringify({ event: "step_update", step_update: { tool_name: "read_file" } }),
    JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "done",
        conversation_id: "conv1",
        structured_output: {
          summary: "The schedule page is missing Sunday.",
          findings: [
            {
              files: ["src/page.tsx"],
              evidence: "The page lists Saturday only.",
              suggestedAction: "Add Sunday to the schedule.",
            },
          ],
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    }),
  ].join("\n");

const parentEnv = {
  PATH: process.env.PATH ?? "/usr/bin",
  GH_TOKEN: "gh-secret",
  GITHUB_TOKEN: "github-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  SSH_AUTH_SOCK: "/tmp/ssh-agent",
  HOME: "/home/jim",
};

describe("antigravity model rules", () => {
  it("drops Anthropic rows and refuses to substitute a missing model", () => {
    const models = parseModelList(catalog);
    expect(models.map((model) => model.slug)).toEqual(["gemini-4-argon-high"]);
    const missing = resolveModelChoice({
      discovered: models,
      requested: "gemini-3.1-pro-high",
      configured: "gemini-4-argon-medium",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.models).toEqual(["gemini-4-argon-high"]);
    expect(missing.detail).toContain("gemini-3.1-pro-high");
    expect(missing.detail).not.toContain("gemini-4-argon-medium");

    const claude = resolveModelChoice({
      discovered: models,
      requested: "claude-opus-4",
      configured: undefined,
    });
    expect(claude.ok).toBe(false);
  });

  it("labels a configured choice unverified when discovery fails", () => {
    const chosen = resolveModelChoice({
      discovered: null,
      requested: undefined,
      configured: "gemini-4-argon-high",
    });
    expect(chosen).toEqual({ ok: true, slug: "gemini-4-argon-high", unverified: true });
    const empty = resolveModelChoice({
      discovered: null,
      requested: undefined,
      configured: undefined,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.detail).toContain("AI_OS_ANTIGRAVITY_MODEL");
  });

  it("keeps Sol and Astra on different base models", () => {
    expect(defaultRoleModelsAreIndependent()).toBe(true);
  });

  it("records token counts and leaves subscription quota unknown", () => {
    const reported = advisoryUsage({
      projectId: "usba",
      taskId: "task-demo",
      attemptId: "attempt-1",
      agentId: "antigravity",
      requestedModel: "gemini-4-argon-high",
      actualModel: null,
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(reported.map((entry) => entry.kind)).toEqual(["reported_tokens", "unknown"]);
    const missing = advisoryUsage({
      projectId: "usba",
      taskId: "task-demo",
      attemptId: "attempt-1",
      agentId: "antigravity",
      requestedModel: "gemini-4-argon-high",
      actualModel: "gemini-4-argon-high",
      inputTokens: null,
      outputTokens: 4,
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.kind).toBe("unknown");
  });

  it("does not pass a timeout unless the task supplies one", () => {
    const args = reviewArguments({
      prompt: "review",
      model: "gemini-4-argon-high",
      scratch: "/tmp/scratch",
      schemaPath: "/tmp/schema.json",
    });
    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--print-timeout");
    expect(args).not.toContain("--dangerously-skip-permissions");
    const limited = reviewArguments({
      prompt: "review",
      model: "gemini-4-argon-high",
      scratch: "/tmp/scratch",
      schemaPath: "/tmp/schema.json",
      timeLimit: "15m",
    });
    expect(limited).toContain("--print-timeout");
  });
});

describe("antigravity advisory review", () => {
  it("checks out the requested commit in a read-only worktree", async () => {
    await withRepo(async ({ repo, sha }) => {
      const calls: Array<{
        readonly args: readonly string[];
        readonly env: Record<string, string>;
        readonly cwd: string;
      }> = [];
      const spawner: CliSpawner = {
        spawn: (input) => {
          calls.push({ args: input.args, env: { ...input.env }, cwd: input.cwd });
          if (input.args[0] === "models") return finished(catalog);
          return finished(successResult("gemini-4-argon-high"));
        },
      };
      const isolation = path.join(path.dirname(repo), "isolation");
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: isolation,
        context: { ...assignmentExample.contextPackage, repoCommit: sha },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high",
        configuredModel: "gemini-4-argon-medium",
        timeLimit: "15m",
        command: "agy",
        spawner,
        env: parentEnv,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(result.requestedModel).toBe("gemini-4-argon-high");
      expect(result.actualModel).toBe("gemini-4-argon-high");
      expect(result.unverified).toBe(false);
      expect(result.commit).toBe(sha);
      expect(result.findings[0]?.commit).toBe(sha);
      expect(result.inputTokens).toBe(12);
      const review = calls.find((call) => call.args.includes("-p"));
      expect(review).toBeDefined();
      expect(review?.args).toEqual(
        expect.arrayContaining([
          "--model",
          "gemini-4-argon-high",
          "--sandbox",
          "--add-dir",
          path.join(isolation, "scratch"),
          "--output-format",
          "stream-json",
          "--print-timeout",
          "15m",
        ]),
      );
      expect(review?.args).not.toContain("--dangerously-skip-permissions");
      expect(review?.cwd).toBe(path.join(isolation, "source"));
      expect(review?.env.GH_TOKEN).toBeUndefined();
      expect(review?.env.GITHUB_TOKEN).toBeUndefined();
      expect(review?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(review?.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(review?.env.HOME).toBe(path.join(isolation, "home"));
      const head = (await git(["rev-parse", "HEAD"], path.join(isolation, "source"))).trim();
      expect(head).toBe(sha);
      const sourceMode = (await stat(path.join(isolation, "source"))).mode & 0o777;
      const fileMode = (await stat(path.join(isolation, "source", "README.md"))).mode & 0o777;
      expect(sourceMode & 0o222).toBe(0);
      expect(fileMode & 0o222).toBe(0);
      await writeFile(path.join(isolation, "scratch", "note.txt"), "ok");
      const settings = JSON.parse(
        await readFile(
          path.join(isolation, "home", ".gemini", "antigravity-cli", "settings.json"),
          "utf8",
        ),
      ) as { permissions: { deny: string[] } };
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining([
          `write_file(${path.join(isolation, "source")})`,
          "command(git push)",
          "command(git merge)",
        ]),
      );
    });
  });

  it("does not start a review when the requested model is absent", async () => {
    let reviews = 0;
    const spawner: CliSpawner = {
      spawn: (input) => {
        if (input.args.includes("-p")) reviews += 1;
        return finished(catalog);
      },
    };
    const result = await runAdvisoryReview({
      repoRoot: "/tmp",
      isolationRoot: "/tmp/unused",
      context: assignmentExample.contextPackage,
      intake: intakeV2Example,
      requestedModel: "gemini-3.1-pro-high",
      configuredModel: "gemini-4-argon-high",
      spawner,
      env: parentEnv,
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.models).toEqual(["gemini-4-argon-high"]);
    expect(reviews).toBe(0);
  });

  it("runs a typed model as unverified when the CLI cannot list models", async () => {
    await withRepo(async ({ repo, sha }) => {
      const spawner: CliSpawner = {
        spawn: (input) => {
          if (input.args[0] === "models") return finished("", 1);
          return finished(successResult("gemini-4-argon-high"));
        },
      };
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: path.join(path.dirname(repo), "isolation"),
        context: { ...assignmentExample.contextPackage, repoCommit: sha },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high",
        configuredModel: undefined,
        spawner,
        env: parentEnv,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(result.unverified).toBe(true);
      expect(result.actualModel).toBe("gemini-4-argon-high");
    });
  });

  it("stops when discovery fails and nobody chose a model", async () => {
    const spawner: CliSpawner = {
      spawn: () => finished("", 1),
    };
    const result = await runAdvisoryReview({
      repoRoot: "/tmp",
      isolationRoot: "/tmp/unused",
      context: assignmentExample.contextPackage,
      intake: intakeV2Example,
      requestedModel: undefined,
      configuredModel: undefined,
      spawner,
      env: parentEnv,
    });
    expect(result.status).toBe("unavailable");
  });

  it("reports a model mismatch and keeps both names", async () => {
    await withRepo(async ({ repo, sha }) => {
      const spawner: CliSpawner = {
        spawn: (input) =>
          input.args[0] === "models"
            ? finished(`${catalog}gemini-3.1-pro-high  Gemini 3.1 Pro High\n`)
            : finished(successResult("gemini-3.1-pro-high")),
      };
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: path.join(path.dirname(repo), "isolation"),
        context: { ...assignmentExample.contextPackage, repoCommit: sha },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high",
        configuredModel: undefined,
        spawner,
        env: parentEnv,
      });
      expect(result.status).toBe("model_mismatch");
      if (result.status !== "model_mismatch") return;
      expect(result.requestedModel).toBe("gemini-4-argon-high");
      expect(result.actualModel).toBe("gemini-3.1-pro-high");
      expect(result.findings).toHaveLength(1);
      expect(result.detail).toContain("Nothing was substituted");
    });
  });

  it("cancels when the caller aborts the review", async () => {
    await withRepo(async ({ repo, sha }) => {
      const controller = new AbortController();
      const spawner: CliSpawner = {
        spawn: (input) => {
          if (input.args[0] === "models") return finished(catalog);
          controller.abort();
          let finish: (code: number | null) => void = () => undefined;
          const exited = new Promise<number | null>((resolve) => {
            finish = resolve;
          });
          return {
            stdout: lines(""),
            stderr: lines(""),
            interrupt: () => finish(130),
            exited,
          };
        },
      };
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: path.join(path.dirname(repo), "isolation"),
        context: { ...assignmentExample.contextPackage, repoCommit: sha },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high",
        configuredModel: undefined,
        signal: controller.signal,
        spawner,
        env: parentEnv,
      });
      expect(result.status).toBe("canceled");
    });
  });

  it("rejects a short commit and a bad time limit before launching", async () => {
    let spawned = 0;
    const spawner: CliSpawner = {
      spawn: () => {
        spawned += 1;
        return finished(catalog);
      },
    };
    const short = await runAdvisoryReview({
      repoRoot: "/tmp",
      isolationRoot: "/tmp/unused",
      context: { ...assignmentExample.contextPackage, repoCommit: "abc" },
      intake: intakeV2Example,
      requestedModel: "gemini-4-argon-high",
      configuredModel: undefined,
      spawner,
      env: parentEnv,
    });
    const timed = await runAdvisoryReview({
      repoRoot: "/tmp",
      isolationRoot: "/tmp/unused",
      context: assignmentExample.contextPackage,
      intake: intakeV2Example,
      requestedModel: "gemini-4-argon-high",
      configuredModel: undefined,
      timeLimit: "soon",
      spawner,
      env: parentEnv,
    });
    expect(short.status).toBe("failed");
    expect(timed.status).toBe("failed");
    expect(spawned).toBe(0);
  });

  it("fails when the CLI omits structured findings", async () => {
    await withRepo(async ({ repo, sha }) => {
      const spawner: CliSpawner = {
        spawn: (input) =>
          input.args[0] === "models"
            ? finished(catalog)
            : finished(
                JSON.stringify({
                  event: "result",
                  result: { status: "SUCCESS", response: "prose only" },
                }),
              ),
      };
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: path.join(path.dirname(repo), "isolation"),
        context: { ...assignmentExample.contextPackage, repoCommit: sha },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high",
        configuredModel: undefined,
        spawner,
        env: parentEnv,
      });
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.detail).toContain("structured findings");
      expect(result.actualModel).toBeNull();
    });
  });
});

describe("antigravity listing", () => {
  it("keeps a configured slug unverified when agy models exits", async () => {
    const catalogResult = await listAntigravityModels({
      configuredModel: "gemini-4-argon-high",
      spawner: { spawn: () => finished("", 1) },
    });
    expect(catalogResult.source).toBe("unverified");
    expect(catalogResult.models.map((model) => model.slug)).toEqual(["gemini-4-argon-high"]);
  });
});

it("scrubs review credentials", () => {
  const env = advisoryEnvironment(parentEnv, "/tmp/home", "/tmp/scratch");
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GIT_CONFIG_GLOBAL).toBe(path.join("/tmp/home", "gitconfig"));
  const parsed = parseCliRun(
    [JSON.stringify({ event: "init", init: { model: "gemini-4-argon-high" } })],
    "c".repeat(40),
  );
  expect(parsed.model).toBe("gemini-4-argon-high");
  expect(parsed.structured).toBeNull();
});
