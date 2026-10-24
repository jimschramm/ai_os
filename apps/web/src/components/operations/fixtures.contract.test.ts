import { describe, expect, it } from "@effect/vitest";
import {
  applySequence,
  decodeAssignmentV1,
  decodeCompletionSubmissionV1,
  decodeIntake,
  decodeMemoryGraphV1,
  decodeProgressReportV1,
  decodeQaVerdictV1,
  decodeSequenceState,
  decodeUsageMeasurementV1,
  leaseIdFor,
  taskLinkFor,
  type SequenceState,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import type { OperationsTask } from "./fixtures";
import { OPERATIONS_TASKS } from "./fixtures";
import { MEMORY_GRAPH } from "./memoryFixtures";

const named = (taskId: string, step: string) => (error: unknown) =>
  new Error(`${taskId} ${step}: ${error instanceof Error ? error.message : String(error)}`);

const eventsFor = (task: OperationsTask): readonly unknown[] => {
  const source = structuredClone(task);
  const assignment = source.assignment;
  if (assignment === null) {
    return [{ type: "intake", intake: source.intake }];
  }
  const events: unknown[] = [
    { type: "intake", intake: source.intake },
    {
      type: "acknowledge",
      acknowledgment: {
        version: "v1",
        taskId: source.id,
        taskLink: taskLinkFor(source.id),
        durable: true,
        receivedAt: source.updatedAt,
      },
    },
    { type: "assign", assignment },
  ];
  if (source.phase === "assigned") {
    return events;
  }
  events.push({ type: "start_execution" });
  if (source.qa !== null && source.qa.availability === "available") {
    events.push({
      type: "record_runtime_models",
      taskId: source.id,
      attemptId: assignment.attemptId,
      generation: 1,
      leaseId: leaseIdFor(1),
      role: "implementer",
      requested: source.qa.implementerModel,
      actual: source.qa.implementerModel,
    });
  }
  for (const measurement of source.usage) {
    events.push({
      type: "report_usage",
      generation: 1,
      leaseId: leaseIdFor(1),
      measurement,
    });
  }
  const progress = source.progress.at(-1);
  if (progress !== undefined) {
    events.push({ type: "report_progress", report: progress });
  }
  if (source.phase === "executing") {
    return events;
  }
  if (source.phase === "recovery_pending") {
    events.push({
      type: "heartbeat_lapsed",
      lapse: {
        version: "v1",
        taskId: source.id,
        attemptId: assignment.attemptId,
        generation: 1,
        leaseId: leaseIdFor(1),
      },
    });
    return events;
  }
  if (source.completion !== null) {
    const recordedImplementer = events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "record_runtime_models" &&
        "role" in event &&
        event.role === "implementer",
    );
    if (!recordedImplementer) {
      // The fixture names the model that ran. Production does not infer it.
      events.push({
        type: "record_runtime_models",
        taskId: source.id,
        attemptId: assignment.attemptId,
        generation: 1,
        leaseId: leaseIdFor(1),
        role: "implementer",
        requested: assignment.implementerModel,
        actual: assignment.implementerModel,
      });
    }
    events.push({ type: "submit_completion", completion: source.completion });
  }
  if (source.qa !== null && source.qa.availability === "available") {
    events.push({
      type: "record_runtime_models",
      taskId: source.id,
      attemptId: assignment.attemptId,
      generation: 1,
      leaseId: leaseIdFor(1),
      role: "reviewer",
      requested: source.qa.qaModel,
      actual: source.qa.qaModel,
    });
    events.push({ type: "qa", threadId: "thread-qa", qa: source.qa });
  } else if (source.qa !== null) {
    events.push({ type: "qa", qa: source.qa });
  }
  return events;
};

const assertReached = (task: OperationsTask, state: SequenceState) => {
  if (state.phase !== task.phase) {
    throw new Error(`${task.id} replayed to ${state.phase}, fixture says ${task.phase}`);
  }
  switch (state.phase) {
    case "assigned":
      expect(state.assignment).toEqual(task.assignment);
      expect(state.heldRun).toBeNull();
      expect(task.completion).toBeNull();
      expect(task.qa).toBeNull();
      expect(task.progress).toEqual([]);
      return;
    case "executing":
      expect(state.assignment).toEqual(task.assignment);
      expect(state.run.progress).toEqual(task.progress.at(-1) ?? null);
      expect(state.run.usage).toEqual(task.usage);
      expect(task.completion).toBeNull();
      expect(task.qa).toBeNull();
      return;
    case "recovery_pending":
      expect(state.assignment).toEqual(task.assignment);
      expect(state.run.progress).toEqual(task.progress.at(-1) ?? null);
      expect(state.run.usage).toEqual(task.usage);
      expect(state.recoveryLabel).toBe("Execution status unknown");
      return;
    case "awaiting_qa":
      expect(state.assignment).toEqual(task.assignment);
      expect(state.completion).toEqual(task.completion);
      expect(state.qa).toEqual(task.qa);
      expect(state.run.progress).toEqual(task.progress.at(-1) ?? null);
      expect(state.run.usage).toEqual(task.usage);
      expect(state.completion.generation).toBe(state.run.generation);
      expect(state.completion.leaseId).toBe(state.run.leaseId);
      expect(state.completion.attemptId).toBe(state.assignment.attemptId);
      return;
    case "rework":
      expect(state.assignment).toEqual(task.assignment);
      expect(state.completion).toEqual(task.completion);
      expect(state.qa).toEqual(task.qa);
      expect(state.run.progress).toEqual(task.progress.at(-1) ?? null);
      expect(state.run.usage).toEqual(task.usage);
      expect(state.assignment.attemptId).toBe(state.completion.attemptId);
      expect(state.qa.attemptId).toBe(state.assignment.attemptId);
      expect(state.completion.generation).toBe(state.run.generation);
      expect(state.completion.leaseId).toBe(state.run.leaseId);
      expect(state.run.progress?.generation).toBe(state.run.generation);
      expect(state.run.progress?.attemptId).toBe(state.assignment.attemptId);
      expect(state.reworkRevision).toEqual(state.qa.artifactRevision);
      return;
    case "accepted":
      expect(state.assignment).toEqual(task.assignment);
      expect(state.completion).toEqual(task.completion);
      expect(state.qa).toEqual(task.qa);
      expect(state.run.usage).toEqual(task.usage);
      expect(state.deliveries).toEqual([]);
      expect(state.completion.attemptId).toBe(state.assignment.attemptId);
      expect(state.qa.attemptId).toBe(state.assignment.attemptId);
      expect(state.completion.generation).toBe(state.run.generation);
      return;
    default:
      throw new Error(`${task.id} phase ${state.phase} is not replayed from fixture events`);
  }
};

describe("operations fixtures", () => {
  it.effect("decodes every fixture through its contract", () =>
    Effect.gen(function* () {
      yield* decodeMemoryGraphV1(structuredClone(MEMORY_GRAPH)).pipe(
        Effect.mapError(named("memory", "graph")),
      );
      for (const task of OPERATIONS_TASKS) {
        yield* decodeIntake(structuredClone(task.intake)).pipe(
          Effect.mapError(named(task.id, "intake")),
        );
        if (task.assignment !== null) {
          yield* decodeAssignmentV1(structuredClone(task.assignment)).pipe(
            Effect.mapError(named(task.id, "assignment")),
          );
        }
        for (const report of task.progress) {
          yield* decodeProgressReportV1(structuredClone(report)).pipe(
            Effect.mapError(named(task.id, "progress")),
          );
        }
        if (task.completion !== null) {
          yield* decodeCompletionSubmissionV1(structuredClone(task.completion)).pipe(
            Effect.mapError(named(task.id, "completion")),
          );
        }
        if (task.qa !== null) {
          yield* decodeQaVerdictV1(structuredClone(task.qa)).pipe(
            Effect.mapError(named(task.id, "qa")),
          );
        }
        for (const measurement of task.usage) {
          yield* decodeUsageMeasurementV1(structuredClone(measurement)).pipe(
            Effect.mapError(named(task.id, "usage")),
          );
        }
        const state = yield* applySequence(eventsFor(task)).pipe(
          Effect.mapError(named(task.id, "sequence")),
        );
        yield* decodeSequenceState(structuredClone(state)).pipe(
          Effect.mapError(named(task.id, "sequence state")),
        );
        assertReached(task, state);
      }
    }),
  );
});
