// @effect-diagnostics nodeBuiltinImport:off - These tests read a temp review marker and wait on its removal.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import type { AdvisorySuccess } from "@t3tools/ai-os-adapter";
import { assignmentExample, intakeExample } from "@t3tools/ai-os-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AntigravityReviews, makeAntigravityReviews, startTicksOf } from "./aiOsAntigravity.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";

const finished: AdvisorySuccess = {
  status: "completed",
  requestedModel: "gemini-4-argon-high",
  actualModel: "gemini-4-argon-high",
  unverified: false,
  commit: "c".repeat(40),
  summary: "Reviewed.",
  findings: [],
  progressNote: "",
  conversationId: null,
  inputTokens: null,
  outputTokens: null,
  sourcePath: "/tmp/source",
  scratchPath: "/tmp/scratch",
  detail: null,
};

const markerPath = (dir: string, taskId: string) =>
  NodePath.join(dir, "antigravity", taskId, "active.json");

const writeMarker = (
  dir: string,
  taskId: string,
  marker: {
    readonly pid: number | null;
    readonly writtenAt?: number;
    readonly bootId?: string | null;
    readonly startTicks?: string | null;
  },
) => {
  const isolationRoot = NodePath.join(dir, "antigravity", taskId, "root");
  NodeFS.mkdirSync(isolationRoot, { recursive: true });
  const file = markerPath(dir, taskId);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const body: Record<string, unknown> = {
    pid: marker.pid,
    isolationRoot,
    generation: 1,
    bootId: marker.bootId ?? null,
    startTicks: marker.startTicks ?? null,
  };
  if (marker.writtenAt !== undefined) body.writtenAt = marker.writtenAt;
  NodeFS.writeFileSync(file, JSON.stringify(body));
  return file;
};

const waitUntilGone = (file: string) =>
  Effect.callback<void>((resume) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    };
    if (!NodeFS.existsSync(file)) {
      finish();
      return Effect.void;
    }
    const watcher = NodeFS.watch(NodePath.dirname(file), () => {
      if (!NodeFS.existsSync(file)) finish();
    });
    if (!NodeFS.existsSync(file)) finish();
    return Effect.sync(() => watcher.close());
  });

const reviewsIn = (dir: string, deps: Parameters<typeof makeAntigravityReviews>[0]) =>
  makeAntigravityReviews(deps).pipe(
    Layer.provide(
      Layer.succeed(ProjectStore.ProjectStoreV2, {
        get: () => Effect.succeed(Option.some({ workspaceRoot: dir })),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: dir,
      } as ServerConfig.ServerConfig["Service"]),
    ),
    Layer.provide(NodeServices.layer),
  );

const useReviews = <A, E>(
  deps: Parameters<typeof makeAntigravityReviews>[0],
  use: (reviews: AntigravityReviews["Service"], dir: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agy-recover-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const context = yield* Layer.build(reviewsIn(dir, deps));
    const reviews = Context.get(context, AntigravityReviews);
    return yield* use(reviews, dir);
  });

it("reads the process start field after the command name", () => {
  expect(startTicksOf("12 (agy worker) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4242 0 0")).toBe(
    "4242",
  );
  expect(startTicksOf("not a stat")).toBeNull();
});

it.effect("treats a pid-null marker from before this server as stopped", () =>
  useReviews({ signal: () => undefined }, (reviews, dir) =>
    Effect.gen(function* () {
      const stale = writeMarker(dir, "task-stale", { pid: null, writtenAt: -1 });
      const legacy = writeMarker(dir, "task-legacy", { pid: null });
      const fresh = writeMarker(dir, "task-fresh", {
        pid: null,
        writtenAt: Number.MAX_SAFE_INTEGER,
      });
      expect(yield* reviews.recover("task-stale")).toEqual({ status: "stopped" });
      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(yield* reviews.recover("task-legacy")).toEqual({ status: "stopped" });
      expect(NodeFS.existsSync(legacy)).toBe(false);
      expect(yield* reviews.recover("task-fresh")).toEqual({ status: "still_running" });
      expect(NodeFS.existsSync(fresh)).toBe(true);
    }),
  ),
);

it.effect("does not signal a pid whose start identity changed", () =>
  Effect.gen(function* () {
    const signaled: number[] = [];
    const identity = { bootId: "boot-live", startTicks: "50" };
    yield* useReviews(
      {
        pidAlive: () => true,
        readIdentity: async () => identity,
        signal: (pid) => {
          signaled.push(pid);
        },
      },
      (reviews, dir) =>
        Effect.gen(function* () {
          const reused = writeMarker(dir, "task-reused", {
            pid: 4242,
            writtenAt: -1,
            bootId: "boot-old",
            startTicks: "10",
          });
          expect(yield* reviews.recover("task-reused")).toEqual({ status: "stopped" });
          expect(signaled).toEqual([]);
          expect(NodeFS.existsSync(reused)).toBe(false);

          const current = writeMarker(dir, "task-current", {
            pid: 4242,
            writtenAt: -1,
            bootId: identity.bootId,
            startTicks: identity.startTicks,
          });
          expect(yield* reviews.recover("task-current")).toEqual({ status: "still_running" });
          expect(signaled).toEqual([4242]);
          expect(NodeFS.existsSync(current)).toBe(true);
        }),
    );
  }),
);

it.effect("deletes the marker when the review finishes", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agy-finish-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    let sawMarker = false;
    const file = markerPath(dir, "task-demo");
    const failed = markerPath(dir, "task-fail");
    const context = yield* Layer.build(
      reviewsIn(dir, {
        listModels: async () => ({
          source: "cli" as const,
          models: [{ slug: "gemini-4-argon-high", label: "Argon" }],
          detail: null,
        }),
        runReview: async (input) => {
          if (input.isolationRoot.includes("task-fail")) {
            throw new Error("agy exited");
          }
          sawMarker = NodeFS.existsSync(file);
          return finished;
        },
      }),
    );
    const reviews = Context.get(context, AntigravityReviews);
    const opened = yield* reviews.start({
      projectId: intakeExample.projectId,
      taskId: "task-demo",
      generation: 1,
      intake: intakeExample,
      context: assignmentExample.contextPackage,
      requestedModel: "gemini-4-argon-high",
    });
    expect(opened.status).toBe("running");
    yield* waitUntilGone(file);
    expect(sawMarker).toBe(true);
    expect(NodeFS.existsSync(file)).toBe(false);
    const crashed = yield* reviews.start({
      projectId: intakeExample.projectId,
      taskId: "task-fail",
      generation: 1,
      intake: intakeExample,
      context: assignmentExample.contextPackage,
      requestedModel: "gemini-4-argon-high",
    });
    expect(crashed.status).toBe("running");
    yield* waitUntilGone(failed);
    expect(NodeFS.existsSync(failed)).toBe(false);
  }),
);
