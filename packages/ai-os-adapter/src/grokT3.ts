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
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GrokT3Error } from "./errors.ts";
import type { T3LocalClient, T3ThreadView } from "./t3Client.ts";
import { WORKER_CAPABILITIES, type WorkerAdapter, type WorkerCapability } from "./worker.ts";

export interface AttemptSession {
  readonly taskId: string;
  readonly title: string;
  readonly state: SequenceState;
  readonly threadId: string | null;
  readonly launchKey: string;
  readonly updatedAt: string;
}

export interface AdapterBoardCard {
  readonly taskId: string;
  readonly title: string;
  readonly state: SequenceState;
  readonly threadId: string | null;
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

export interface GrokT3Adapter extends WorkerAdapter {
  readonly record: (input: {
    readonly taskId: string;
    readonly title: string;
    readonly intake: unknown;
    readonly context: unknown;
  }) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly start: (taskId: string) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly sync: (taskId: string) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly resume: (taskId: string) => Effect.Effect<AttemptSession, GrokT3Error>;
  readonly cancel: (taskId: string) => Effect.Effect<AttemptSession, GrokT3Error>;
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
  readonly readResult: (taskId: string) => AdapterBoardCard | null;
}

export const GROK_T3_CAPABILITIES: ReadonlySet<WorkerCapability> = new Set(WORKER_CAPABILITIES);

export const createGrokT3Adapter = (input: {
  readonly client: T3LocalClient;
  readonly clock: () => string;
  readonly store?: SessionStore;
  readonly workerId?: string;
  readonly model?: string;
}): GrokT3Adapter => {
  const store = input.store ?? memorySessionStore();
  const workerId = input.workerId ?? "codex-t3";
  const model = input.model ?? "gpt-5.4";

  const load = (taskId: string) => {
    const session = store.get(taskId);
    return session === undefined
      ? fail("unknown_task", `No recorded task ${taskId}.`)
      : Effect.succeed(session);
  };

  const save = (session: AttemptSession) => {
    store.put(session);
    return session;
  };

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
      const launchKey = fingerprintOf({ taskId, intake, context });
      const existing = store.get(taskId);
      if (existing !== undefined) {
        return existing.launchKey === launchKey
          ? existing
          : yield* fail(
              "idempotency_conflict",
              "This task id was already recorded with a different intake.",
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
      return save({
        taskId,
        title: request.title.trim(),
        state,
        threadId: null,
        launchKey,
        updatedAt: at,
      });
    });

  const start = (taskId: string) =>
    Effect.gen(function* () {
      let session = yield* load(taskId);
      if (session.state.phase !== "assigned" && session.state.phase !== "executing") {
        return yield* fail("contract", `Cannot start from ${session.state.phase}.`);
      }
      if (session.threadId === null) {
        const intake = session.state.intake;
        const launched = yield* input.client.launch({
          idempotencyKey: session.launchKey,
          projectId: intake.projectId,
          title: session.title,
          prompt: renderPrompt(intake, session.state.assignment.contextPackage),
          contextPackage: session.state.assignment.contextPackage,
        });
        session = save({ ...session, threadId: launched.threadId, updatedAt: input.clock() });
      }
      if (session.state.phase === "assigned") {
        session = save(yield* step(session, { type: "start_execution" }));
      }
      return session;
    });

  const reportProgress = (taskId: string, report: ProgressReportV1) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      return save(yield* step(session, { type: "report_progress", report }));
    });

  const sync = (taskId: string) =>
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
      if (view === null || view.status === "interrupted") {
        if (session.state.phase !== "executing") return session;
        const run = session.state.run;
        return save(
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
          session = save(
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
          session = save(
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
      return save(
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

  const resume = (taskId: string) =>
    Effect.gen(function* () {
      let session = yield* load(taskId);
      if (session.state.phase === "recovery_pending") {
        session = save(
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
      if (session.state.phase === "assigned") {
        session = yield* start(taskId);
      }
      if (session.state.phase === "executing") {
        session = yield* sync(taskId);
      }
      return session;
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
        yield* input.client.stop(session.threadId);
      }
      return save(next);
    });

  const heartbeat = (taskId: string, observedAt: string, leaseExpiresAt: string) =>
    Effect.gen(function* () {
      const session = yield* load(taskId);
      if (session.state.phase !== "executing") {
        return yield* fail("contract", `Cannot heartbeat from ${session.state.phase}.`);
      }
      return save(
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
    record,
    start,
    sync,
    resume,
    cancel,
    heartbeat,
    reportProgress,
    list: () => store.list(),
    readResult: (taskId) => {
      const session = store.get(taskId);
      return session === undefined ? null : boardCard(session);
    },
  };
};
