import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  assignmentExample,
  decodeAssignmentV1,
  decodeCompletionSubmissionV1,
  decodeIntake,
  decodeSequenceState,
  intakeV2Example,
  leaseIdFor,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  clearAdapterBoard,
  createGrokT3Adapter,
  httpT3LocalClient,
  memorySessionStore,
  readAdapterBoard,
  requireCapability,
  type WorkerAdapter,
} from "./index.ts";

const CLOCK = "2026-10-21T18:00:00Z";
const SHA = "ab".repeat(20);

interface StoredThread {
  prompt: string;
  requirements: string;
  status: "running" | "completed" | "interrupted";
  text: string | null;
  revision: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

interface FakeT3 {
  readonly origin: string;
  readonly launchCount: () => number;
  readonly stopCount: () => number;
  readonly threadCount: () => number;
  readonly prompt: (threadId: string) => string;
  readonly requirements: (threadId: string) => string;
  readonly setThread: (threadId: string, patch: Partial<StoredThread>) => void;
}

const IncomingLaunch = Schema.Struct({
  idempotencyKey: Schema.String,
  prompt: Schema.String,
  contextPackage: Schema.Struct({
    requirements: Schema.String,
  }),
});

const decodeIncomingLaunch = Schema.decodeUnknownEffect(IncomingLaunch);

const pathname = (url: string): string => {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return url.split("?")[0] ?? "/";
  }
};

const respond = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });

const startFake = Effect.gen(function* () {
  const byKey = new Map<string, string>();
  const threads = new Map<string, StoredThread>();
  let launches = 0;
  let stops = 0;

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = pathname(request.url);
    if (request.method === "POST" && path === "/api/orchestration/threads") {
      const raw = yield* request.json.pipe(Effect.orElseSucceed(() => null));
      const body = yield* decodeIncomingLaunch(raw).pipe(Effect.orElseSucceed(() => null));
      if (body === null) return respond(400, { error: "body" });
      const existing = byKey.get(body.idempotencyKey);
      if (existing !== undefined) return respond(200, { threadId: existing, created: false });
      launches += 1;
      const threadId = `t3-thread-${launches}`;
      byKey.set(body.idempotencyKey, threadId);
      threads.set(threadId, {
        prompt: body.prompt,
        requirements: body.contextPackage.requirements,
        status: "running",
        text: null,
        revision: null,
      });
      return respond(200, { threadId, created: true });
    }
    const stop = /^\/api\/orchestration\/threads\/([^/]+)\/stop$/.exec(path);
    if (request.method === "POST" && stop?.[1] !== undefined) {
      stops += 1;
      return respond(200, { stopped: true });
    }
    const read = /^\/api\/orchestration\/threads\/([^/]+)$/.exec(path);
    if (request.method === "GET" && read?.[1] !== undefined) {
      const threadId = decodeURIComponent(read[1]);
      const thread = threads.get(threadId);
      if (thread === undefined) return respond(404, { error: "missing" });
      return respond(200, {
        threadId,
        status: thread.status,
        text: thread.text,
        revision: thread.revision,
        ...(thread.inputTokens === undefined ? {} : { inputTokens: thread.inputTokens }),
        ...(thread.outputTokens === undefined ? {} : { outputTokens: thread.outputTokens }),
      });
    }
    return respond(404, { error: "missing" });
  });

  yield* HttpServer.serveEffect(handler);
  const origin = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
  return {
    origin,
    launchCount: () => launches,
    stopCount: () => stops,
    threadCount: () => threads.size,
    prompt: (threadId: string) => threads.get(threadId)?.prompt ?? "",
    requirements: (threadId: string) => threads.get(threadId)?.requirements ?? "",
    setThread: (threadId: string, patch: Partial<StoredThread>) => {
      const current = threads.get(threadId);
      if (current === undefined) throw new Error(`Missing ${threadId}`);
      threads.set(threadId, { ...current, ...patch });
    },
  };
});

const withFake = <A, E, R>(use: (fake: FakeT3) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      clearAdapterBoard();
      const fake = yield* startFake;
      return yield* use(fake);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

const context = assignmentExample.contextPackage;

const record = (
  adapter: ReturnType<typeof createGrokT3Adapter>,
  taskId = "task-usba-page",
  intake: unknown = intakeV2Example,
) =>
  adapter.record({
    taskId,
    title: "Tournament page",
    intake,
    context,
  });

it.effect("launches one T3 thread and reads the completion back", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: httpT3LocalClient(fake.origin),
        clock: () => CLOCK,
      });
      const recorded = yield* record(adapter);
      assert.strictEqual(recorded.state.phase, "assigned");
      assert.strictEqual(fake.launchCount(), 0);

      const started = yield* adapter.start(recorded.taskId);
      assert.strictEqual(started.state.phase, "executing");
      assert.strictEqual(started.threadId, "t3-thread-1");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.threadCount(), 1);
      assert.equal(fake.prompt("t3-thread-1").includes(intakeV2Example.request), true);
      assert.strictEqual(fake.requirements("t3-thread-1"), context.requirements);
      assert.equal(fake.prompt("t3-thread-1").includes(context.requirements), true);

      yield* adapter.start(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);

      fake.setThread("t3-thread-1", { inputTokens: 12, outputTokens: 3 });
      const working = yield* adapter.sync(recorded.taskId);
      assert.strictEqual(working.state.phase, "executing");
      if (working.state.phase !== "executing") return;
      assert.strictEqual(working.state.run.progress?.status, "working");
      assert.strictEqual(working.state.run.usage.length, 1);
      assert.strictEqual(working.state.run.usage[0]?.kind, "reported_tokens");
      yield* adapter.sync(recorded.taskId);
      if (working.state.phase !== "executing") return;
      const again = yield* adapter.sync(recorded.taskId);
      if (again.state.phase !== "executing") return;
      assert.strictEqual(again.state.run.usage.length, 1);

      const stale = yield* adapter
        .reportProgress(recorded.taskId, {
          version: "v1",
          taskId: recorded.taskId,
          attemptId: `${recorded.taskId}-attempt-1`,
          generation: 2,
          leaseId: leaseIdFor(2),
          status: "working",
          blockers: [],
          partialArtifacts: [],
        })
        .pipe(Effect.flip);
      assert.strictEqual(stale.reason, "stale_generation");

      fake.setThread("t3-thread-1", {
        status: "completed",
        text: "Published the tournament page.",
        revision: SHA,
      });
      const done = yield* adapter.sync(recorded.taskId);
      assert.strictEqual(done.state.phase, "awaiting_qa");
      if (done.state.phase !== "awaiting_qa") return;
      assert.strictEqual(done.state.completion.generation, 1);
      assert.strictEqual(done.state.completion.leaseId, leaseIdFor(1));
      assert.strictEqual(done.state.completion.claimedOutcome, "Published the tournament page.");
      assert.deepStrictEqual(done.state.completion.evidence, [
        { kind: "readback", ref: "thread:t3-thread-1" },
      ]);
      yield* decodeIntake(done.state.intake);
      yield* decodeAssignmentV1(done.state.assignment);
      yield* decodeCompletionSubmissionV1(done.state.completion);
      yield* decodeSequenceState(done.state);
      yield* adapter.sync(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);

      const card = adapter.readResult(recorded.taskId);
      assert.strictEqual(card?.threadId, "t3-thread-1");
      assert.strictEqual(readAdapterBoard().length, 1);
    }),
  ),
);

it.effect("recovers an interrupted thread without launching another", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const store = memorySessionStore();
      const client = httpT3LocalClient(fake.origin);
      const adapter = createGrokT3Adapter({ client, clock: () => CLOCK, store });
      const recorded = yield* record(adapter);
      const started = yield* adapter.start(recorded.taskId);
      assert.strictEqual(started.threadId, "t3-thread-1");
      fake.setThread("t3-thread-1", { status: "interrupted" });
      const blocked = yield* adapter.sync(recorded.taskId);
      assert.strictEqual(blocked.state.phase, "recovery_pending");
      assert.strictEqual(fake.launchCount(), 1);

      const resumedAdapter = createGrokT3Adapter({ client, clock: () => CLOCK, store });
      fake.setThread("t3-thread-1", {
        status: "completed",
        text: "Finished after the lapse.",
        revision: SHA,
      });
      const resumed = yield* resumedAdapter.resume(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.threadCount(), 1);
      assert.strictEqual(resumed.state.phase, "awaiting_qa");
      if (resumed.state.phase !== "awaiting_qa") return;
      assert.strictEqual(resumed.state.completion.generation, 2);
      assert.strictEqual(resumed.state.completion.leaseId, leaseIdFor(2));
      assert.strictEqual(resumed.threadId, "t3-thread-1");

      const conflict = yield* resumedAdapter
        .resume(recorded.taskId)
        .pipe(Effect.flatMap(() => resumedAdapter.resume(recorded.taskId)));
      assert.strictEqual(conflict.threadId, "t3-thread-1");
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("reuses the server thread when the local record lost the id", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const store = memorySessionStore();
      const client = httpT3LocalClient(fake.origin);
      const adapter = createGrokT3Adapter({ client, clock: () => CLOCK, store });
      const recorded = yield* record(adapter);
      const first = yield* client.launch({
        idempotencyKey: recorded.launchKey,
        projectId: intakeV2Example.projectId,
        title: recorded.title,
        prompt: "already sent",
        contextPackage: context,
      });
      assert.strictEqual(first.created, true);
      const second = yield* client.launch({
        idempotencyKey: recorded.launchKey,
        projectId: intakeV2Example.projectId,
        title: recorded.title,
        prompt: "already sent",
        contextPackage: context,
      });
      assert.strictEqual(second.created, false);
      assert.strictEqual(second.threadId, first.threadId);
      const started = yield* adapter.start(recorded.taskId);
      assert.strictEqual(started.threadId, first.threadId);
      assert.strictEqual(fake.threadCount(), 1);
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("stops the thread once when cancel is repeated", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: httpT3LocalClient(fake.origin),
        clock: () => CLOCK,
      });
      const recorded = yield* record(adapter);
      yield* adapter.start(recorded.taskId);
      const cancelled = yield* adapter.cancel(recorded.taskId);
      assert.strictEqual(cancelled.state.phase, "cancelled");
      yield* adapter.cancel(recorded.taskId);
      assert.strictEqual(fake.stopCount(), 1);
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("refuses a second intake on the same task id and an undeclared capability", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: httpT3LocalClient(fake.origin),
        clock: () => CLOCK,
      });
      yield* record(adapter);
      const other = {
        ...intakeV2Example,
        request: "A different request that must not replace the receipt.",
      };
      const conflict = yield* record(adapter, "task-usba-page", other).pipe(Effect.flip);
      assert.strictEqual(conflict.reason, "idempotency_conflict");
      const same = yield* record(adapter);
      assert.strictEqual(same.state.phase, "assigned");

      const jira: WorkerAdapter = { id: "jira", capabilities: new Set(["report_status"]) };
      const unsupported = yield* requireCapability(jira, "start").pipe(Effect.flip);
      assert.strictEqual(unsupported.reason, "unsupported");
      yield* requireCapability(adapter, "idempotency");
      yield* requireCapability(adapter, "receive_context");
    }),
  ),
);
