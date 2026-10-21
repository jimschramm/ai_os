import type { AdapterBoardCard } from "@t3tools/ai-os-adapter";
import { RECOVERY_PENDING_LABEL, type SequenceState } from "@t3tools/ai-os-contracts";

import type { OperationsProjectId, OperationsTask } from "./fixtures";
import { tasksForProject } from "./model";

const PROJECTS = new Set<OperationsProjectId>(["personal", "usba", "ai_os"]);

const isProject = (value: string): value is OperationsProjectId =>
  PROJECTS.has(value as OperationsProjectId);

const completionOf = (state: SequenceState) => {
  switch (state.phase) {
    case "awaiting_qa":
    case "rework":
    case "accepted":
      return state.completion;
    default:
      return null;
  }
};

const qaOf = (state: SequenceState): OperationsTask["qa"] => {
  switch (state.phase) {
    case "awaiting_qa":
    case "rework":
    case "accepted":
      return state.qa;
    default:
      return null;
  }
};

const runOf = (state: SequenceState) => {
  switch (state.phase) {
    case "executing":
    case "awaiting_qa":
    case "rework":
    case "accepted":
    case "recovery_pending":
    case "failed":
      return state.run;
    case "cancelled":
      return state.run;
    default:
      return null;
  }
};

const taskFromAdapterCard = (card: AdapterBoardCard): OperationsTask | null => {
  const { state } = card;
  if (!("assignment" in state) || !("intake" in state)) return null;
  if (!("originatingConversationId" in state.intake)) return null;
  if (!isProject(state.intake.projectId)) return null;
  const completion = completionOf(state);
  const run = runOf(state);
  const needsYou =
    state.phase === "recovery_pending"
      ? {
          id: `${card.taskId}-recovery`,
          kind: "blocker" as const,
          summary: RECOVERY_PENDING_LABEL,
          nextAction: "Read the T3 thread, then resume or take over.",
          actionLabel: "Resume",
        }
      : state.phase === "failed"
        ? {
            id: `${card.taskId}-failed`,
            kind: "blocker" as const,
            summary: state.blocker.summary,
            nextAction: state.blocker.nextAction,
            actionLabel: "I'll take it",
          }
        : null;
  return {
    id: card.taskId,
    projectId: state.intake.projectId,
    phase: state.phase,
    title: card.title,
    agent: "Codex via T3",
    surface: "T3",
    updatedAt: card.updatedAt,
    intake: state.intake,
    assignment: state.assignment,
    progress: run?.progress === null || run?.progress === undefined ? [] : [run.progress],
    completion,
    qa: qaOf(state),
    revision: completion?.artifactRevision ?? null,
    facts: [],
    candidates: [],
    usage: run?.usage ?? [],
    needsYou,
    result: completion?.claimedOutcome ?? null,
  };
};

/** Live adapter cards replace a fixture with the same id. An empty list leaves the fixtures. */
export const tasksForBoard = (
  projectId: OperationsProjectId,
  cards: readonly AdapterBoardCard[],
): readonly OperationsTask[] => {
  const fixtures = tasksForProject(projectId);
  const live = cards.flatMap((card) => {
    const task = taskFromAdapterCard(card);
    return task !== null && task.projectId === projectId ? [task] : [];
  });
  if (live.length === 0) return fixtures;
  const liveIds = new Set(live.map((task) => task.id));
  return [...live, ...fixtures.filter((task) => !liveIds.has(task.id))];
};
