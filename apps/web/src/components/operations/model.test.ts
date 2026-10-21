import { describe, expect, it } from "vite-plus/test";
import { RECOVERY_PENDING_LABEL } from "@t3tools/ai-os-contracts";

import { OPERATIONS_TASKS } from "./fixtures";
import { factById } from "./memoryModel";
import {
  columnFor,
  contextFactIds,
  needsYou,
  qaStatusLabel,
  tasksForProject,
  tasksInColumn,
  usageFor,
} from "./model";

describe("operations mockup", () => {
  it("keeps vector candidates out of the context package", () => {
    for (const task of OPERATIONS_TASKS) {
      const factIds = contextFactIds(task);
      for (const candidate of task.candidates) {
        expect(factIds.has(candidate.nodeId)).toBe(false);
      }
      for (const factId of factIds) {
        expect(factById(factId)?.projectId).toBe(task.projectId);
      }
    }
  });

  it("places recovery on Blocked and labels it as unknown", () => {
    const blocked = tasksInColumn(tasksForProject("usba"), "Blocked");
    expect(blocked.map((task) => task.id)).toEqual(["bracket-sync"]);
    expect(columnFor(blocked[0]!)).toBe("Blocked");
    expect(qaStatusLabel(blocked[0]!)).toBe(RECOVERY_PENDING_LABEL);
    expect(qaStatusLabel(blocked[0]!)).toBe("Execution status unknown");
  });

  it("fills every column for the USBA workspace", () => {
    const tasks = tasksForProject("usba");
    expect(tasksInColumn(tasks, "Ready").length).toBeGreaterThan(0);
    expect(tasksInColumn(tasks, "Running").length).toBeGreaterThan(0);
    expect(tasksInColumn(tasks, "Blocked").length).toBeGreaterThan(0);
    expect(tasksInColumn(tasks, "Review").length).toBeGreaterThan(0);
    expect(tasksInColumn(tasks, "Done").length).toBeGreaterThan(0);
  });

  it("filters tasks to the selected workspace", () => {
    expect(tasksForProject("personal").every((task) => task.projectId === "personal")).toBe(true);
    expect(tasksForProject("ai_os").some((task) => task.projectId === "usba")).toBe(false);
  });

  it("keeps reported tokens, estimated cost, subscription, and unknown distinct", () => {
    const { entries, totals } = usageFor(tasksForProject("usba"));
    expect(entries.some((entry) => entry.kind === "reported_tokens")).toBe(true);
    expect(entries.some((entry) => entry.kind === "estimated_cost")).toBe(true);
    expect(entries.some((entry) => entry.kind === "subscription_allocation")).toBe(true);
    expect(entries.some((entry) => entry.kind === "unknown")).toBe(true);
    expect(totals.reportedTokens.input).toBe(820 + 4100 + 6200);
    expect(totals.reportedTokens.output).toBe(140 + 960 + 1500);
    expect(totals.estimatedCostMinorUsd).toBe(18 + 7);
    expect(totals.subscriptionAllocationBps).toBe(400);
    expect(totals.unknownCount).toBe(1);
    expect(totals.reportedTokens.input).not.toBe(totals.estimatedCostMinorUsd);
  });

  it("gives USBA a blocker and a decision with a next action", () => {
    const items = needsYou(tasksForProject("usba"));
    expect(items.map((item) => item.kind).sort()).toEqual(["blocker", "blocker", "decision"]);
    for (const item of items) {
      expect(item.nextAction.length).toBeGreaterThan(0);
      expect(item.actionLabel.length).toBeGreaterThan(0);
    }
  });
});
