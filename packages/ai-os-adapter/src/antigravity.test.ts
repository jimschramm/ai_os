// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assignmentExample, intakeV2Example } from "@t3tools/ai-os-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advisoryEnvironment,
  advisoryUsage,
  antigravitySupports,
  listAntigravityModels,
  parseCliRun,
  parseModelList,
  resolveModelChoice,
  reviewArguments,
  runAdvisoryReview,
  sweepAdvisoryIsolation,
  type CliSpawner,
  type SpawnedCli,
} from "./antigravity.ts";

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
    NodeChildProcess.execFile(
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
    NodeChildProcess.execFile("chmod", ["-R", "u+w", root], () => resolve());
  });

const withRepo = async <T>(
  run: (input: { readonly repo: string; readonly sha: string }) => Promise<T>,
): Promise<T> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-review-"));
  const repo = NodePath.join(root, "repo");
  await NodeFSP.mkdir(repo);
  try {
    await git(["init"], repo);
    await NodeFSP.writeFile(NodePath.join(repo, "README.md"), "schedule\n");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "schedule"], repo);
    const sha = (await git(["rev-parse", "HEAD"], repo)).trim();
    return await run({ repo, sha });
  } finally {
    await allowCleanup(root);
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const catalog = "gemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-4-6\tClaude Opus 4.6\n";

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
  AWS_ACCESS_KEY_ID: "aws-id",
  GEMINI_API_KEY: "gem-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  SSH_AUTH_SOCK: "/tmp/ssh-agent",
  HOME: "/home/jim",
};

describe("antigravity model rules", () => {
  it("drops Anthropic rows and refuses to substitute a missing model", () => {
    const models = parseModelList(catalog);
    expect(models).toEqual([{ slug: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }]);
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

  it("skips lines that are not a tab-separated slug and name", () => {
    const parsed = parseModelList(
      [
        "gemini-4-argon-high\tGemini 4 Argon (High)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6",
        "not a model row",
        "\tmissing slug",
        "bad slug!!!\tNope",
        "gemini-4-argon-low\t",
        "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { slug: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
      { slug: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
    ]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList("usage: agy models\n")).toEqual([]);
  });

  it("declares advisory capabilities and does not resume or heartbeat", () => {
    expect(antigravitySupports("start")).toBe(true);
    expect(antigravitySupports("cancel")).toBe(true);
    expect(antigravitySupports("report_status")).toBe(true);
    expect(antigravitySupports("return_artifacts")).toBe(true);
    expect(antigravitySupports("report_usage")).toBe(true);
    expect(antigravitySupports("receive_context")).toBe(true);
    expect(antigravitySupports("idempotency")).toBe(true);
    expect(antigravitySupports("resume")).toBe(false);
    expect(antigravitySupports("heartbeat")).toBe(false);
    expect(antigravitySupports("retrieve_assignments")).toBe(false);
  });

  it("records token counts for the model that ran and does not substitute the request", () => {
    const unreported = advisoryUsage({
      projectId: "usba",
      taskId: "task-demo",
      attemptId: "attempt-1",
      agentId: "antigravity",
      requestedModel: "gemini-4-argon-high",
      actualModel: null,
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(unreported).toEqual([]);
    const reported = advisoryUsage({
      projectId: "usba",
      taskId: "task-demo",
      attemptId: "attempt-1",
      agentId: "antigravity",
      requestedModel: "gemini-4-argon-high",
      actualModel: "gpt-6-astra",
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(reported.map((entry) => entry.kind)).toEqual(["reported_tokens", "unknown"]);
    expect(reported[0]).toMatchObject({ attribution: { model: "gpt-6-astra" } });
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
      let sourceMode = 0;
      let fileMode = 0;
      let deny: string[] = [];
      const spawner: CliSpawner = {
        spawn: (input) => {
          calls.push({ args: input.args, env: { ...input.env }, cwd: input.cwd });
          if (input.args[0] === "models") return finished(catalog);
          sourceMode = NodeFS.statSync(input.cwd).mode & 0o777;
          fileMode = NodeFS.statSync(NodePath.join(input.cwd, "README.md")).mode & 0o777;
          NodeFS.writeFileSync(
            NodePath.join(NodePath.dirname(input.cwd), "scratch", "note.txt"),
            "ok",
          );
          deny = (
            JSON.parse(
              NodeFS.readFileSync(
                NodePath.join(
                  NodePath.dirname(input.cwd),
                  "home",
                  ".gemini",
                  "antigravity-cli",
                  "settings.json",
                ),
                "utf8",
              ),
            ) as { permissions: { deny: string[] } }
          ).permissions.deny;
          return finished(successResult("gemini-4-argon-high"));
        },
      };
      const isolation = NodePath.join(NodePath.dirname(repo), "isolation");
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
      const discovery = calls.find((call) => call.args[0] === "models");
      expect(Object.keys(discovery?.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
      expect(discovery?.env.GH_TOKEN).toBeUndefined();
      expect(discovery?.env.GEMINI_API_KEY).toBeUndefined();
      expect(review?.args).toEqual(
        expect.arrayContaining([
          "--model",
          "gemini-4-argon-high",
          "--sandbox",
          "--add-dir",
          NodePath.join(NodePath.dirname(review?.cwd ?? ""), "scratch"),
          "--output-format",
          "stream-json",
          "--print-timeout",
          "15m",
        ]),
      );
      expect(review?.args).not.toContain("--dangerously-skip-permissions");
      expect(review?.cwd.startsWith(isolation)).toBe(true);
      expect(review?.env.GH_TOKEN).toBeUndefined();
      expect(review?.env.GITHUB_TOKEN).toBeUndefined();
      expect(review?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(review?.env.GEMINI_API_KEY).toBeUndefined();
      expect(review?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(review?.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(review?.env.HOME).toBe(NodePath.join(NodePath.dirname(review?.cwd ?? ""), "home"));
      expect(sourceMode & 0o222).toBe(0);
      expect(fileMode & 0o222).toBe(0);
      expect(deny).toEqual(
        expect.arrayContaining([
          `write_file(${review?.cwd})`,
          "command(git push)",
          "command(git merge)",
        ]),
      );
      await expect(NodeFSP.stat(review?.cwd ?? "")).rejects.toThrow();
      const listed = await git(["worktree", "list", "--porcelain"], repo);
      expect(listed).not.toContain(review?.cwd ?? "missing");
    });
  });

  it("does not follow a symlink out of the worktree", async () => {
    await withRepo(async ({ repo, sha }) => {
      const outside = NodePath.join(NodePath.dirname(repo), "outside.txt");
      await NodeFSP.writeFile(outside, "secret\n", { mode: 0o644 });
      await NodeFSP.symlink(outside, NodePath.join(repo, "linked.txt"));
      await git(["add", "linked.txt"], repo);
      await git(["commit", "-m", "link"], repo);
      const linked = (await git(["rev-parse", "HEAD"], repo)).trim();
      expect(linked).not.toBe(sha);
      let linkIsSymlink = false;
      const spawner: CliSpawner = {
        spawn: (input) => {
          if (input.args[0] === "models") return finished(catalog);
          linkIsSymlink = NodeFS.lstatSync(NodePath.join(input.cwd, "linked.txt")).isSymbolicLink();
          return finished(successResult("gemini-4-argon-high"));
        },
      };
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: NodePath.join(NodePath.dirname(repo), "isolation"),
        context: { ...assignmentExample.contextPackage, repoCommit: linked },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high",
        configuredModel: undefined,
        spawner,
        env: parentEnv,
      });
      expect(result.status).toBe("completed");
      expect(linkIsSymlink).toBe(true);
      expect((await NodeFSP.stat(outside)).mode & 0o222).not.toBe(0);
    });
  });

  it("removes the worktree so a failed review can be retried", async () => {
    await withRepo(async ({ repo, sha }) => {
      let reviews = 0;
      const spawner: CliSpawner = {
        spawn: (input) => {
          if (input.args[0] === "models") return finished(catalog);
          reviews += 1;
          return reviews === 1 ? finished("", 1) : finished(successResult("gemini-4-argon-high"));
        },
      };
      const isolation = NodePath.join(NodePath.dirname(repo), "isolation");
      const input = {
        repoRoot: repo,
        isolationRoot: isolation,
        context: { ...assignmentExample.contextPackage, repoCommit: sha },
        intake: intakeV2Example,
        requestedModel: "gemini-4-argon-high" as const,
        configuredModel: undefined,
        spawner,
        env: parentEnv,
      };
      const first = await runAdvisoryReview(input);
      expect(first.status).toBe("failed");
      expect(await git(["worktree", "list", "--porcelain"], repo)).not.toContain(isolation);
      const second = await runAdvisoryReview(input);
      expect(second.status).toBe("completed");
      expect(await git(["worktree", "list", "--porcelain"], repo)).not.toContain(isolation);
      expect(await NodeFSP.readdir(isolation).catch(() => [])).toEqual([]);
    });
  });

  it("sweeps a leftover read-only worktree and stops the recorded child", async () => {
    await withRepo(async ({ repo, sha }) => {
      const isolation = NodePath.join(NodePath.dirname(repo), "isolation");
      const attempt = NodePath.join(isolation, "attempt01");
      const source = NodePath.join(attempt, "source");
      await git(["worktree", "add", "--detach", source, sha], repo);
      await new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile("chmod", ["-R", "a-w", source], (error) =>
          error ? reject(error) : resolve(),
        );
      });
      const pid = await new Promise<number>((resolve, reject) => {
        const parent = NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{detached:true,stdio:'ignore'}); child.unref(); process.stdout.write(String(child.pid));",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let out = "";
        parent.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        parent.on("exit", (code) => {
          const parsed = Number(out.trim());
          if (code === 0 && Number.isInteger(parsed)) resolve(parsed);
          else reject(new Error("The orphan child did not start."));
        });
      });
      try {
        expect(await sweepAdvisoryIsolation({ root: isolation, pid })).toBe(true);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
        expect(await git(["worktree", "list", "--porcelain"], repo)).not.toContain(source);
        expect(await NodeFSP.readdir(isolation).catch(() => [])).toEqual([]);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The sweep already stopped it.
        }
      }
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
        isolationRoot: NodePath.join(NodePath.dirname(repo), "isolation"),
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
            ? finished(`${catalog}gemini-3.1-pro-high\tGemini 3.1 Pro High\n`)
            : finished(successResult("gemini-3.1-pro-high")),
      };
      const result = await runAdvisoryReview({
        repoRoot: repo,
        isolationRoot: NodePath.join(NodePath.dirname(repo), "isolation"),
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
        isolationRoot: NodePath.join(NodePath.dirname(repo), "isolation"),
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
        isolationRoot: NodePath.join(NodePath.dirname(repo), "isolation"),
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
  it("gives model discovery only the allowlisted environment", async () => {
    const seen: Array<Record<string, string>> = [];
    const catalogResult = await listAntigravityModels({
      env: parentEnv,
      spawner: {
        spawn: (input) => {
          seen.push({ ...input.env });
          return finished("usage: agy models\nnot a model row\n");
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(seen[0]?.GH_TOKEN).toBeUndefined();
    expect(seen[0]?.GITHUB_TOKEN).toBeUndefined();
    expect(seen[0]?.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(seen[0]?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(seen[0]?.GEMINI_API_KEY).toBeUndefined();
    expect(seen[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen[0]?.SSH_AUTH_SOCK).toBeUndefined();
    expect(catalogResult).toEqual({
      source: "cli",
      models: [],
      detail: "The CLI listed no usable models after Anthropic models were excluded.",
    });
  });

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
  expect(env.GIT_CONFIG_GLOBAL).toBe(NodePath.join("/tmp/home", "gitconfig"));
  const parsed = parseCliRun(
    [JSON.stringify({ event: "init", init: { model: "gemini-4-argon-high" } })],
    "c".repeat(40),
  );
  expect(parsed.model).toBe("gemini-4-argon-high");
  expect(parsed.structured).toBeNull();
});
