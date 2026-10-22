import {
  applySequence,
  applySequenceEvent,
  ContractId,
  decodeContextPackageSnapshotV1,
  decodeIntake,
  fingerprintOf,
  taskLinkFor,
  type ContextPackageSnapshotV1,
  type Intake,
  type ProgressReportV1,
  type SequenceEvent,
  type SequenceState,
  type UsageMeasurementV1,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type AdapterBoardCard } from "./board.ts";

export type { AdapterBoardCard };
import { GrokT3Error } from "./errors.ts";
import { T3_LAUNCH_DEFAULTS, type T3LocalClient, type T3ThreadView } from "./t3Client.ts";
import { type WorkerAdapter, type WorkerCapability } from "./worker.ts";

export interface AttemptSession {
  readonly taskId: string;
  readonly title: string;
  readonly state: SequenceState;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly launchKey: string;
  readonly updatedAt: string;
}

export interface SessionStore {
  readonly get: (taskId: string) => AttemptSession | undefined;
  readonly put: (session: AttemptSession) => void;
  readonly list: () => readonly AttemptSession[];
}

const board = new Map<string, AdapterBoardCard>();

export const boardCard = (session: AttemptSession): AdapterBoardCard => ({
  taskId: session.taskId,
  title: session.title,
  state: session.state,
  threadId: session.threadId,
  updatedAt: session.updatedAt,
});

export const readAdapterBoard = (): readonly AdapterBoardCard[] => [...board.values()];

export const clearAdapterBoard = (): void => {
  board.clear();
};

const publish = (session: AttemptSession) => {
  board.set(session.taskId, boardCard(session));
};

export const memorySessionStore = (): SessionStore => {
  const sessions = new Map<string, AttemptSession>();
  return {
    get: (taskId) => sessions.get(taskId),
    put: (session) => {
      sessions.set(session.taskId, session);
      publish(session);
    },
    list: () => [...sessions.values()],
  };
};

export const renderPrompt = (intake: Intake, context: ContextPackageSnapshotV1): string => {
  const memory = context.memoryVersions.length === 0 ? "none" : context.memoryVersions.join(", ");
  const constraints =
    intake.constraints.length === 0
      ? []
      : ["", "Constraints", ...intake.constraints.map((item) => `- ${item}`)];
  return [
    intake.request,
    "",
    "Context package",
    context.requirements,
    `Memory: ${memory}`,
    `Repo: ${context.repoCommit}`,
    `Authorization: ${context.authorizationScope}`,
    ...constraints,
    "",
    "Acceptance criteria",
    ...intake.acceptanceCriteria.map((item) => `- ${item}`),
  ].join("\n");
};

const fail = (reason: GrokT3Error["reason"], detail: string) =>
  Effect.fail(new GrokT3Error({ reason, detail }));

const decodeTaskIdSchema = Schema.decodeEffect(ContractId);

const decodeTaskId = (taskId: string) =>
  decodeTaskIdSchema(taskId).pipe(
    Effect.mapError(() => new GrokT3Error({ reason: "invalid_task", detail: "Invalid task id." })),
  );

const contractError = (error: { readonly reason: string; readonly message: string }) =>
  new GrokT3Error({
    reason:
      error.reason === "idempotency_conflict" || error.reason === "stale_generation"
        ? error.reason
        : "contract",
    detail: error.message,
  });

const evidenceRefFor = (threadId: string): string => {
  const ref = `thread:${threadId}`;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref) && ref.length <= 128 ? ref : "thread:t3";
};

const GIT_SHA = /^[0-9a-f]{40}$/;

const artifactRevision = (view: T3ThreadView) =>
  view.revision !== null && GIT_SHA.test(view.revision)
    ? { type: "git" as const, sha: view.revision }
    : { type: "named" as const, kind: "page" as const, id: "t3-result" };

export interface GrokT3Adapter extends WorkerAdapter<AttemptSession, AdapterBoardCard> {
  readonly record: (input: {
    readonly taskId: string;
    readonly title: string;
    readonly intake: unknown;
    readonly context: unknown;
  }) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly heartbeat: (
    taskId: string,
    observedAt: string,
    leaseExpiresAt: string,
  ) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly reportProgress: (
    taskId: string,
    report: ProgressReportV1,
  ) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly list: () => readonly AttemptSession[];
}

/** Capabilities this adapter actually implements. Retrieval of foreign assignments is not one of them. */
export const GROK_T3_CAPABILITIES: ReadonlySet<WorkerCapability> = new Set([
  "start",
  "report_status",
  "cancel",
  "resume",
  "return_artifacts",
  "report_usage",
  "receive_context",
  "heartbeat",
  "idempotency",
]);

export const createGrokT3Adapter = (input: {
  readonly client: T3LocalClient;
  readonly clock: () => string;
  readonly store?: SessionStore;
  readonly workerId?: string;
  readonly model?: string;
  readonly instanceId?: string;
}): GrokT3Adapter => {
  const store = input.store ?? memorySessionStore();
  const workerId = input.workerId ?? "codex-t3";
  const model = input.model ?? "gpt-5.4";
  const resolvedInstanceId = input.instanceId ?? T3_LAUNCH_DEFAULTS.instanceId;

  const load = (taskId: string) => {
    const session = store.get(taskId);
    return session === undefined
      ? fail("unknown_task", `No recorded task ${taskId}.`)
      : Effect.succeed(session);
  };

  const save = (session: AttemptSession) =>
    Effect.gen(function* () {
      store.put(session);
      yield* input.client.publishBoard(readAdapterBoard());
      return session;
    });

  const step = (session: AttemptSession, event: SequenceEvent) =>
    applySequenceEvent(session.state, event).pipe(
      Effect.mapError(contractError),
      Effect.map((state) => ({ ...session, state, updatedAt: input.clock() })),
    );

  const assignmentFor = (taskId: string, context: ContextPackageSnapshotV1) => ({
    version: "v1" as const,
    taskId,
    attemptId: `${taskId}-attempt-1`,
    assignmentId: `${taskId}-assignment-1`,
    workerId,
    implementerModel: model,
    scope: context.authorizationScope,
    contextPackage: context,
  });

  const record = (request: {
    readonly taskId: string;
    readonly title: string;
    readonly intake: unknown;
    readonly context: unknown;
  }) =>
    Effect.gen(function* () {
      if (request.title.trim().length === 0) {
        return yield* fail("invalid_task", "A recorded task needs a title.");
      }
      const taskId = yield* decodeTaskId(request.taskId);
      const intake = yield* decodeIntake(request.intake).pipe(
        Effect.mapError(
          () => new GrokT3Error({ reason: "invalid_task", detail: "Invalid intake." }),
        ),
      );
      const context = yield* decodeContextPackageSnapshotV1(request.context).pipe(
        Effect.mapError(
          () => new GrokT3Error({ reason: "invalid_task", detail: "Invalid context package." }),
        ),
      );
      const title = request.title.trim();
      const launchKey = fingerprintOf({
        projectId: intake.projectId,
        title,
        modelSelection: { instanceId: resolvedInstanceId, model },
        runtimeMode: T3_LAUNCH_DEFAULTS.runtimeMode,
        interactionMode: T3_LAUNCH_DEFAULTS.interactionMode,
        workspaceStrategy: T3_LAUNCH_DEFAULTS.workspaceStrategy,
        prompt: renderPrompt(intake, context),
        attachments: [],
        context,
      });
      const existing = store.get(taskId);
      if (existing !== undefined) {
        return existing.launchKey === launchKey
          ? existing
          : yield* fail(
              "idempotency_conflict",
              "This task id was already recorded with a different launch payload.",
            );
      }
      const at = input.clock();
      const state = yield* applySequence([
        { type: "intake", intake },
        {
          type: "acknowledge",
          acknowledgment: {
            version: "v1",
            taskId,
            taskLink: taskLinkFor(taskId),
            durable: true,
            receivedAt: at,
          },
        },
        { type: "assign", assignment: assignmentFor(taskId, context) },
      ]).pipe(Effect.mapError(contractError));
      return yield* save({
        taskId,
        title,
        state,
        threadId: null,
        runId: null,
        launchKey,
        updatedAt: at,
      });
    });

  const launch = (taskId: string) =>
    Effect.gen(function* () {
      let session = yield* load(taskId);
      if (session.state.phase !== "assigned" && session.state.phase !== "executing") {
        return yield* fail("contract", `Cannot launch from ${session.state.phase}.`);
      }
      if (session.threadId === null) {
        const intake = session.state.intake;
        const launched = yield* input.client.launch({
          idempotencyKey: session.launchKey,
          projectId: intake.projectId,
          title: session.title,
          model,
          instanceId: resolvedInstanceId,
          prompt: renderPrompt(intake, session.state.assignment.contextPackage),
          contextPackage: session.state.assignment.contextPackage,
        });
        session = yield* save({
          ...session,
          threadId: launched.threadId,
          runId: launched.runId,
          updatedAt: input.clock(),
        });
      }
      if (session.state.phase === "assigned") {
        session = yield* save(yield* step(session, { type: "start_execution" }));
      }
      return session;
    });

  const reportProgress = (taskId: string, report: ProgressReportV1) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      return yield* save(yield* step(session, { type: "report_progress", report }));
    });

  const observe = (taskId: string) =>
    Effect.gen(function* () {
      let session = yield* load(taskId);
      if (session.threadId === null || session.state.phase === "idle") {
        return yield* fail("not_started", "The task has no T3 thread yet.");
      }
      const threadId = session.threadId;
      const view = yield* input.client
        .read(threadId)
        .pipe(
          Effect.catch((error) =>
            session.state.phase === "executing" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
      if (view !== null && view.runId !== null && view.runId !== session.runId) {
        session = yield* save({ ...session, runId: view.runId, updatedAt: input.clock() });
      }
      if (view === null || view.status === "interrupted") {
        if (session.state.phase !== "executing") return session;
        const run = session.state.run;
        return yield* save(
          yield* step(session, {
            type: "heartbeat_lapsed",
            lapse: {
              version: "v1",
              taskId,
              attemptId: session.state.assignment.attemptId,
              generation: run.generation,
              leaseId: run.leaseId,
            },
          }),
        );
      }
      if (session.state.phase !== "executing") return session;
      const run = session.state.run;
      const attemptId = session.state.assignment.attemptId;
      if (view.status === "running") {
        if (run.progress?.status !== "working") {
          session = yield* save(
            yield* step(session, {
              type: "report_progress",
              report: {
                version: "v1",
                taskId,
                attemptId,
                generation: run.generation,
                leaseId: run.leaseId,
                status: "working",
                blockers: [],
                partialArtifacts: [],
              },
            }),
          );
        }
        if (
          session.state.phase === "executing" &&
          session.state.run.usage.length === 0 &&
          view.inputTokens !== undefined &&
          view.outputTokens !== undefined
        ) {
          session = yield* save(
            yield* step(session, {
              type: "report_usage",
              generation: session.state.run.generation,
              leaseId: session.state.run.leaseId,
              measurement: {
                kind: "reported_tokens",
                inputTokens: view.inputTokens,
                outputTokens: view.outputTokens,
                attribution: {
                  projectId: session.state.intake.projectId,
                  taskId,
                  attemptId,
                  agentId: workerId,
                  platform: "t3",
                  provider: "openai",
                  model: { model },
                },
              },
            }),
          );
        }
        return session;
      }
      if (view.status !== "completed") return session;
      const outcome =
        view.text !== null && view.text.length > 0 ? view.text : "T3 thread completed.";
      return yield* save(
        yield* step(session, {
          type: "submit_completion",
          completion: {
            version: "v1",
            taskId,
            attemptId,
            generation: run.generation,
            leaseId: run.leaseId,
            claimedOutcome: outcome,
            artifactRevision: artifactRevision(view),
            evidence: [{ kind: "readback", ref: evidenceRefFor(threadId) }],
          },
        }),
      );
    });

  const recover = (taskId: string) =>
    Effect.gen(function* () {
      let session = yield* load(taskId);
      if (session.state.phase === "recovery_pending") {
        if (session.threadId === null || session.runId === null) {
          return yield* fail("not_started", "The interrupted task has no T3 run to continue.");
        }
        session = yield* save(
          yield* step(session, {
            type: "resolve_recovery",
            command: {
              command: "resolve_recovery",
              outcome: "continue",
              idempotencyKey: `resume-${taskId}`,
              taskId,
              attemptId: session.state.assignment.attemptId,
            },
          }),
        );
      }
      if (
        session.state.phase !== "assigned" ||
        session.threadId === null ||
        session.runId === null
      ) {
        return session;
      }
      const threadId = session.threadId;
      const runId = session.runId;
      const generation = session.state.nextGeneration;
      yield* input.client.continueRun({
        threadId,
        runId,
        commandId: `continue-${taskId}-${generation}`,
        messageId: `continue-msg-${taskId}-${generation}`,
        text: "Continue the interrupted run on this thread.",
      });
      const continued = yield* input.client.read(threadId).pipe(Effect.orElseSucceed(() => null));
      if (continued?.runId != null) {
        session = { ...session, runId: continued.runId };
      }
      return yield* save(yield* step(session, { type: "start_execution" }));
    });

  const cancel = (taskId: string) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      if (!("assignment" in session.state)) {
        return yield* fail("contract", `Cannot cancel from ${session.state.phase}.`);
      }
      const idempotencyKey = `cancel-${taskId}`;
      const seen = session.state.commands.some((entry) => entry.idempotencyKey === idempotencyKey);
      const next = yield* step(session, {
        type: "cancel",
        command: {
          command: "cancel",
          idempotencyKey,
          taskId,
          attemptId: session.state.assignment.attemptId,
        },
      });
      if (!seen && session.threadId !== null) {
        if (session.runId === null) {
          return yield* fail("not_started", "The task has no T3 run to interrupt.");
        }
        yield* input.client.interrupt(session.threadId, session.runId);
      }
      return yield* save(next);
    });

  const reportUsage = (taskId: string, measurement: UsageMeasurementV1) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      if (session.state.phase !== "executing") {
        return yield* fail("contract", `Cannot report_usage from ${session.state.phase}.`);
      }
      return yield* save(
        yield* step(session, {
          type: "report_usage",
          generation: session.state.run.generation,
          leaseId: session.state.run.leaseId,
          measurement,
        }),
      );
    });

  const receiveContext = (taskId: string) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      if (!("assignment" in session.state)) {
        return yield* fail("contract", "This task has no context package.");
      }
      return session.state.assignment.contextPackage;
    });

  const idempotency = (taskId: string, fingerprint: string) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      if (session.launchKey !== fingerprint) {
        return yield* fail(
          "idempotency_conflict",
          "The launch payload does not match the recorded task.",
        );
      }
      return session;
    });

  const result = (taskId: string) => {
    const session = store.get(taskId);
    return session === undefined ? null : boardCard(session);
  };

  const heartbeat = (taskId: string, observedAt: string, leaseExpiresAt: string) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      if (session.state.phase !== "executing") {
        return yield* fail("contract", `Cannot heartbeat from ${session.state.phase}.`);
      }
      return yield* save(
        yield* step(session, {
          type: "heartbeat",
          heartbeat: {
            version: "v1",
            taskId,
            attemptId: session.state.assignment.attemptId,
            generation: session.state.run.generation,
            leaseId: session.state.run.leaseId,
            observedAt,
            leaseExpiresAt,
          },
        }),
      );
    });

  return {
    id: "grok-t3",
    capabilities: GROK_T3_CAPABILITIES,
    operations: {
      start: launch,
      report_status: observe,
      cancel,
      resume: recover,
      return_artifacts: result,
      report_usage: reportUsage,
      receive_context: receiveContext,
      heartbeat,
      idempotency,
    },
    record,
    launch,
    observe,
    recover,
    cancel,
    heartbeat,
    reportProgress,
    list: () => store.list(),
    result,
  };
};
