import type { AdapterBoardCard } from "@t3tools/ai-os-adapter/board";
import { RECOVERY_PENDING_LABEL, type SequenceState } from "@t3tools/ai-os-contracts";

import { OPERATIONS_TASKS, type OperationsTask } from "./fixtures";
import { tasksForProject } from "./model";

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
    case "review_delivered":
    case "failed":
      return state.run;
    case "assigned":
      return state.heldRun;
    case "cancelled":
      return state.run;
    default:
      return null;
  }
};

const taskFromAdapterCard = (card: AdapterBoardCard): OperationsTask | null => {
  const { state } = card;
  if (state.phase === "cancelled" || !("intake" in state)) return null;
  if (!("originatingConversationId" in state.intake)) return null;
  const assignment = "assignment" in state ? state.assignment : null;
  const completion = completionOf(state);
  const run = runOf(state);
  const report = run?.progress ?? null;
  const progressBlocker = report?.status === "blocked" ? report.blockers[0] : undefined;
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
        : progressBlocker === undefined
          ? null
          : {
              id: `${card.taskId}-progress-block`,
              kind: "blocker" as const,
              summary: progressBlocker.summary,
              nextAction: progressBlocker.nextAction,
              actionLabel: "I'll take it",
            };
  return {
    id: card.taskId,
    projectId: state.intake.projectId,
    phase: state.phase,
    title: card.title,
    agent: assignment?.workerId ?? "Unassigned",
    surface: "T3",
    updatedAt: card.updatedAt,
    intake: state.intake,
    assignment,
    progress: report === null ? [] : [report],
    completion,
    qa: qaOf(state),
    advisory: run?.advisory ?? null,
    revision:
      completion?.artifactRevision ??
      (run?.advisory === undefined ? null : { type: "git", sha: run.advisory.commit }),
    facts: [],
    candidates: [],
    usage: run?.usage ?? [],
    needsYou,
    result: completion?.claimedOutcome ?? null,
  };
};

const liveTasks = (cards: readonly AdapterBoardCard[]): readonly OperationsTask[] =>
  cards.flatMap((card) => {
    const task = taskFromAdapterCard(card);
    return task === null ? [] : [task];
  });

/** True when the feed has at least one card the board can show. */
export const hasLiveBoard = (cards: readonly AdapterBoardCard[]): boolean =>
  liveTasks(cards).length > 0;

/**
 * Live cards stand alone. Fixtures show only when the feed has no live card,
 * or when `includeFixtures` is set for the dev demo toggle.
 * Omit `projectId` to keep every project.
 */
export const tasksForBoard = (
  projectId: string | undefined,
  cards: readonly AdapterBoardCard[],
  includeFixtures = false,
): readonly OperationsTask[] => {
  const fixtures = projectId === undefined ? OPERATIONS_TASKS : tasksForProject(projectId);
  const allLive = liveTasks(cards);
  if (allLive.length === 0) return fixtures;
  const live =
    projectId === undefined ? allLive : allLive.filter((task) => task.projectId === projectId);
  if (!includeFixtures) return live;
  const liveIds = new Set(allLive.map((task) => task.id));
  return [...live, ...fixtures.filter((task) => !liveIds.has(task.id))];
};
