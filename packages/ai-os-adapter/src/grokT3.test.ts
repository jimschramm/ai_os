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
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from "effect/http";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { adapterBoardHandler } from "./boardFeed.ts";
import {
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_PATH,
  clearAdapterBoard,
  createGrokT3Adapter,
  decodeAdapterBoard,
  memorySessionStore,
  readAdapterBoard,
  requireCapability,
  wsT3LocalClient,
  type WorkerAdapter,
} from "./index.ts";
import { T3OrchestrationRpc } from "./t3Client.ts";

const CLOCK = "2026-10-21T18:00:00.000Z";
const SHA = "ab".repeat(20);
const NOW = DateTime.makeUnsafe(CLOCK);
const INSTANCE = ProviderInstanceId.make("codex");

interface StoredThread {
  title: string;
  prompt: string;
  requirements: string;
  hasContext: boolean;
  model: string;
  workspace: string;
  status: "running" | "completed" | "interrupted";
  text: string | null;
  revision: string | null;
  inputTokens?: number;
  outputTokens?: number;
  runId: string;
}

interface FakeT3 {
  readonly origin: string;
  readonly launchCount: () => number;
  readonly interruptCount: () => number;
  readonly continueCount: () => number;
  readonly threadCount: () => number;
  readonly prompt: (threadId: string) => string;
  readonly requirements: (threadId: string) => string;
  readonly hasContext: (threadId: string) => boolean;
  readonly model: (threadId: string) => string;
  readonly workspace: (threadId: string) => string;
  readonly runId: (threadId: string) => string;
  readonly continuedRunId: (threadId: string) => string | undefined;
  readonly interruptedRunId: (threadId: string) => string | undefined;
  readonly setThread: (
    threadId: string,
    patch: Partial<
      Pick<StoredThread, "status" | "text" | "revision" | "inputTokens" | "outputTokens">
    >,
  ) => void;
}

const decodeProjection = Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection);

const projectionFor = (threadId: string, thread: StoredThread) => {
  const id = ThreadId.make(threadId);
  const runId = RunId.make(thread.runId);
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId: ProjectId.make(intakeV2Example.projectId),
      title: thread.title,
      providerInstanceId: INSTANCE,
      modelSelection: { instanceId: INSTANCE, model: thread.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId: id,
        ordinal: 1,
        providerInstanceId: INSTANCE,
        modelSelection: { instanceId: INSTANCE, model: thread.model },
        providerThreadId: null,
        userMessageId: MessageId.make("message-user"),
        rootNodeId: null,
        activeAttemptId: null,
        status: thread.status,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: thread.status === "completed" ? NOW : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns:
      thread.inputTokens === undefined || thread.outputTokens === undefined
        ? []
        : [
            {
              id: ProviderTurnId.make("turn-1"),
              providerThreadId: ProviderThreadId.make("provider-thread-1"),
              nodeId: NodeId.make("node-1"),
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "completed",
              startedAt: NOW,
              completedAt: NOW,
              tokenUsage: {
                usedTokens: thread.inputTokens + thread.outputTokens,
                inputTokens: thread.inputTokens,
                outputTokens: thread.outputTokens,
                updatedAt: CLOCK,
              },
            },
          ],
    runtimeRequests: [],
    messages:
      thread.text === null
        ? []
        : [
            {
              createdBy: "user",
              creationSource: "web",
              id: MessageId.make("message-assistant"),
              threadId: id,
              runId,
              nodeId: null,
              role: "assistant",
              text: thread.text,
              attachments: [],
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints:
      thread.revision === null
        ? []
        : [
            {
              id: CheckpointId.make("checkpoint-1"),
              threadId: id,
              scopeId: CheckpointScopeId.make("scope-1"),
              runId,
              nodeId: NodeId.make("node-1"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: 1,
              ref: CheckpointRef.make(thread.revision),
              status: "ready",
              files: [],
              capturedAt: NOW,
            },
          ],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  };
};

const makeFake = () => {
  const byCommand = new Map<string, string>();
  const threads = new Map<string, StoredThread>();
  const continues = new Map<string, string>();
  const interrupts = new Map<string, string>();
  let launches = 0;
  const handlers = T3OrchestrationRpc.of({
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
      Effect.gen(function* () {
        const existing = byCommand.get(input.commandId);
        if (existing !== undefined) {
          const thread = threads.get(existing);
          if (thread === undefined) {
            return yield* Effect.die(`Missing ${existing}`);
          }
          return {
            threadId: ThreadId.make(existing),
            projection: yield* decodeProjection(projectionFor(existing, thread)).pipe(Effect.orDie),
            resumed: true,
          };
        }
        launches += 1;
        const threadId = `t3-thread-${launches}`;
        const runId = `run-${launches}`;
        const context = input.initialMessage?.context;
        threads.set(threadId, {
          title: input.title,
          prompt: input.initialMessage?.text ?? "",
          requirements:
            context?.records.find((record) => record.kind === "context-package") === undefined
              ? ""
              : String(
                  (
                    context.records.find((record) => record.kind === "context-package") as {
                      payload?: { requirements?: string };
                    }
                  ).payload?.requirements ?? "",
                ),
          hasContext: context?.records.some((record) => record.kind === "context-package") === true,
          model: input.modelSelection.model,
          workspace: input.workspaceStrategy.type,
          status: "running",
          text: null,
          revision: null,
          runId,
        });
        byCommand.set(input.commandId, threadId);
        const thread = threads.get(threadId);
        if (thread === undefined) return yield* Effect.die(`Missing ${threadId}`);
        return {
          threadId: ThreadId.make(threadId),
          projection: yield* decodeProjection(projectionFor(threadId, thread)).pipe(Effect.orDie),
          resumed: false,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      Effect.sync(() => {
        if (command.type === "run.interrupt") {
          interrupts.set(command.threadId, command.runId);
          const thread = threads.get(command.threadId);
          if (thread !== undefined) thread.status = "interrupted";
        }
        if (
          command.type === "message.dispatch" &&
          command.manualContinuationOfRunId !== undefined
        ) {
          continues.set(command.threadId, command.manualContinuationOfRunId);
          const thread = threads.get(command.threadId);
          if (thread !== undefined) {
            thread.status = "running";
            thread.runId = `run-continued-${command.manualContinuationOfRunId}`;
          }
        }
        return { sequence: launches };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.gen(function* () {
        const thread = threads.get(input.threadId);
        if (thread === undefined) {
          return yield* Effect.die(`Missing ${input.threadId}`);
        }
        return yield* decodeProjection(projectionFor(input.threadId, thread)).pipe(Effect.orDie);
      }),
  });
  const layer = HttpRouter.serve(
    RpcServer.layer(T3OrchestrationRpc).pipe(
      Layer.provide(T3OrchestrationRpc.toLayer(handlers)),
      Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/ws" })),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(RpcSerialization.layerJson),
  );
  const fake = (origin: string): FakeT3 => ({
    origin,
    launchCount: () => launches,
    interruptCount: () => interrupts.size,
    continueCount: () => continues.size,
    threadCount: () => threads.size,
    prompt: (threadId) => threads.get(threadId)?.prompt ?? "",
    requirements: (threadId) => threads.get(threadId)?.requirements ?? "",
    hasContext: (threadId) => threads.get(threadId)?.hasContext === true,
    model: (threadId) => threads.get(threadId)?.model ?? "",
    workspace: (threadId) => threads.get(threadId)?.workspace ?? "",
    runId: (threadId) => threads.get(threadId)?.runId ?? "",
    continuedRunId: (threadId) => continues.get(threadId),
    interruptedRunId: (threadId) => interrupts.get(threadId),
    setThread: (threadId, patch) => {
      const current = threads.get(threadId);
      if (current === undefined) throw new Error(`Missing ${threadId}`);
      threads.set(threadId, { ...current, ...patch });
    },
  });
  return { layer, fake };
};

const withFake = <A, E, R>(use: (fake: FakeT3) => Effect.Effect<A, E, R>) => {
  const server = makeFake();
  return Effect.gen(function* () {
    clearAdapterBoard();
    const formatted = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
    const url = new URL(formatted);
    // layerTest listens on the unspecified address, which a websocket cannot dial.
    if (url.hostname === "[::]" || url.hostname === "::" || url.hostname === "0.0.0.0") {
      url.hostname = "127.0.0.1";
    }
    return yield* use(server.fake(url.origin));
  }).pipe(Effect.provide(server.layer));
};

const context = assignmentExample.contextPackage;

const record = (
  adapter: ReturnType<typeof createGrokT3Adapter>,
  taskId = "task-usba-page",
  intake: unknown = intakeV2Example,
  title = "Tournament page",
) =>
  adapter.record({
    taskId,
    title,
    intake,
    context,
  });

it.effect("launches one T3 thread and reads the completion back", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: wsT3LocalClient(fake.origin),
        clock: () => CLOCK,
      });
      const recorded = yield* record(adapter);
      assert.strictEqual(recorded.state.phase, "assigned");
      assert.strictEqual(fake.launchCount(), 0);

      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.state.phase, "executing");
      assert.strictEqual(started.threadId, "t3-thread-1");
      assert.strictEqual(started.runId, "run-1");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.threadCount(), 1);
      assert.equal(fake.prompt("t3-thread-1").includes(intakeV2Example.request), true);
      assert.strictEqual(fake.requirements("t3-thread-1"), context.requirements);
      assert.strictEqual(fake.hasContext("t3-thread-1"), true);
      assert.strictEqual(fake.model("t3-thread-1"), "gpt-5.4");
      assert.strictEqual(fake.workspace("t3-thread-1"), "root");

      yield* adapter.launch(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);

      fake.setThread("t3-thread-1", { inputTokens: 12, outputTokens: 3 });
      const working = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(working.state.phase, "executing");
      if (working.state.phase !== "executing") return;
      assert.strictEqual(working.state.run.progress?.status, "working");
      assert.strictEqual(working.state.run.usage.length, 1);
      assert.strictEqual(working.state.run.usage[0]?.kind, "reported_tokens");
      const again = yield* adapter.observe(recorded.taskId);
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
      const done = yield* adapter.observe(recorded.taskId);
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
      yield* adapter.observe(recorded.taskId);
      assert.strictEqual(fake.launchCount(), 1);

      const card = adapter.result(recorded.taskId);
      assert.strictEqual(card?.threadId, "t3-thread-1");
      assert.strictEqual(readAdapterBoard().length, 1);
    }),
  ),
);

it.effect("continues an interrupted run on the same thread", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const store = memorySessionStore();
      const client = wsT3LocalClient(fake.origin);
      const adapter = createGrokT3Adapter({ client, clock: () => CLOCK, store });
      const recorded = yield* record(adapter);
      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.threadId, "t3-thread-1");
      fake.setThread("t3-thread-1", { status: "interrupted" });
      const blocked = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(blocked.state.phase, "recovery_pending");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.continueCount(), 0);

      const resumed = yield* adapter.recover(recorded.taskId);
      assert.strictEqual(resumed.state.phase, "executing");
      assert.strictEqual(resumed.threadId, "t3-thread-1");
      assert.strictEqual(fake.launchCount(), 1);
      assert.strictEqual(fake.threadCount(), 1);
      assert.strictEqual(fake.continueCount(), 1);
      assert.strictEqual(fake.continuedRunId("t3-thread-1"), started.runId);
      assert.strictEqual(resumed.runId, `run-continued-${started.runId}`);
      if (resumed.state.phase !== "executing") return;
      assert.strictEqual(resumed.state.run.generation, 2);
      assert.strictEqual(resumed.state.run.progress, null);

      yield* adapter.recover(recorded.taskId);
      assert.strictEqual(fake.continueCount(), 1);

      fake.setThread("t3-thread-1", {
        status: "completed",
        text: "Finished after the lapse.",
        revision: SHA,
      });
      const done = yield* adapter.observe(recorded.taskId);
      assert.strictEqual(done.state.phase, "awaiting_qa");
      if (done.state.phase !== "awaiting_qa") return;
      assert.strictEqual(done.state.completion.generation, 2);
      assert.strictEqual(done.state.completion.leaseId, leaseIdFor(2));
      assert.strictEqual(done.state.completion.claimedOutcome, "Finished after the lapse.");
    }),
  ),
);

it.effect("reuses the server thread when the local record lost the id", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const store = memorySessionStore();
      const client = wsT3LocalClient(fake.origin);
      const adapter = createGrokT3Adapter({ client, clock: () => CLOCK, store });
      const recorded = yield* record(adapter);
      const request = {
        idempotencyKey: recorded.launchKey,
        projectId: intakeV2Example.projectId,
        title: recorded.title,
        prompt: "already sent",
        contextPackage: context,
        model: "gpt-5.4",
      };
      const first = yield* client.launch(request);
      assert.strictEqual(first.resumed, false);
      const second = yield* client.launch(request);
      assert.strictEqual(second.resumed, true);
      assert.strictEqual(second.threadId, first.threadId);
      const started = yield* adapter.launch(recorded.taskId);
      assert.strictEqual(started.threadId, first.threadId);
      assert.strictEqual(fake.threadCount(), 1);
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("interrupts the run once when cancel is repeated", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: wsT3LocalClient(fake.origin),
        clock: () => CLOCK,
      });
      const recorded = yield* record(adapter);
      const started = yield* adapter.launch(recorded.taskId);
      const cancelled = yield* adapter.cancel(recorded.taskId);
      assert.strictEqual(cancelled.state.phase, "cancelled");
      assert.strictEqual(fake.interruptedRunId("t3-thread-1"), started.runId);
      yield* adapter.cancel(recorded.taskId);
      assert.strictEqual(fake.interruptCount(), 1);
      assert.strictEqual(fake.launchCount(), 1);
    }),
  ),
);

it.effect("refuses a changed title and an undeclared capability", () =>
  withFake((fake) =>
    Effect.gen(function* () {
      const adapter = createGrokT3Adapter({
        client: wsT3LocalClient(fake.origin),
        clock: () => CLOCK,
      });
      yield* record(adapter);
      const conflict = yield* record(
        adapter,
        "task-usba-page",
        intakeV2Example,
        "Renamed page",
      ).pipe(Effect.flip);
      assert.strictEqual(conflict.reason, "idempotency_conflict");
      const same = yield* record(adapter);
      assert.strictEqual(same.state.phase, "assigned");
      assert.strictEqual(fake.launchCount(), 0);

      assert.strictEqual(adapter.capabilities.has("retrieve_assignments"), false);
      assert.strictEqual(adapter.capabilities.has("start"), true);
      assert.strictEqual(adapter.capabilities.has("resume"), true);
      const missing = yield* requireCapability(adapter, "retrieve_assignments").pipe(Effect.flip);
      assert.strictEqual(missing.reason, "unsupported");

      const session = { ok: true } as const;
      const jira: WorkerAdapter<typeof session> = {
        id: "jira",
        capabilities: new Set(["report_status"]),
        launch: () => requireCapability(jira, "start").pipe(Effect.as(session)),
        observe: () => requireCapability(jira, "report_status").pipe(Effect.as(session)),
        cancel: () => requireCapability(jira, "cancel").pipe(Effect.as(session)),
        recover: () => requireCapability(jira, "resume").pipe(Effect.as(session)),
        result: () => null,
      };
      const unsupported = yield* jira.launch("task-usba-page").pipe(Effect.flip);
      assert.strictEqual(unsupported.reason, "unsupported");
      yield* jira.observe("task-usba-page");
      yield* requireCapability(adapter, "idempotency");
      yield* requireCapability(adapter, "receive_context");
    }),
  ),
);

it.effect("serves board cards to another process and pushes the next snapshot", () =>
  Effect.gen(function* () {
    clearAdapterBoard();
    const origin = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
    const adapter = createGrokT3Adapter({
      client: {
        launch: () => Effect.die("The board feed does not launch T3."),
        read: () => Effect.die("The board feed does not read T3."),
        interrupt: () => Effect.die("The board feed does not interrupt T3."),
        continueRun: () => Effect.die("The board feed does not continue T3."),
      },
      clock: () => CLOCK,
    });
    yield* record(adapter);
    const body = (path: string) =>
      HttpClient.execute(HttpClientRequest.get(`${origin}${path}`)).pipe(
        Effect.flatMap((response) =>
          path === ADAPTER_BOARD_EVENTS_PATH
            ? response.stream.pipe(
                Stream.decodeText,
                Stream.take(1),
                Stream.runFold(
                  () => "",
                  (left, right) => left + right,
                ),
              )
            : response.text,
        ),
        Effect.provide(FetchHttpClient.layer),
      );
    const snapshot = decodeAdapterBoard(yield* body(ADAPTER_BOARD_PATH));
    assert.strictEqual(snapshot?.length, 1);
    assert.strictEqual(snapshot?.[0]?.taskId, "task-usba-page");
    const events = yield* body(ADAPTER_BOARD_EVENTS_PATH);
    assert.equal(events.includes("task-usba-page"), true);
    yield* record(adapter, "task-usba-scores");
    const next = decodeAdapterBoard(yield* body(ADAPTER_BOARD_PATH));
    assert.strictEqual(next?.length, 2);
  }).pipe(
    Effect.provide(
      HttpServer.serve(adapterBoardHandler).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    ),
  ),
);
