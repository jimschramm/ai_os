import { describe, expect, it } from "vite-plus/test";

import { tasksForProject, usageFor } from "./model";
import {
  findingsCount,
  progressIndex,
  progressPercent,
  providerGauges,
  qaBreakdown,
  touchSeries,
} from "./boardVisuals";

describe("operations visuals", () => {
  it("keeps reported, estimated, subscription, and unknown on separate marks", () => {
    const gauges = providerGauges(usageFor(tasksForProject("usba")).entries);
    expect(gauges.map((gauge) => gauge.agentId)).toEqual(["grok-bot", "codex-t3", "codex-vscode"]);
    const grok = gauges[0]!;
    const codex = gauges[1]!;
    const vscode = gauges[2]!;
    expect(grok.reportedTokens + codex.reportedTokens).toBe(960 + 12_760);
    expect(grok.tokenRatio + codex.tokenRatio).toBeCloseTo(1);
    expect(grok.caption).toBe("reported tokens");
    expect(grok.liquid).toBeCloseTo(grok.tokenRatio);
    expect(codex.estimatedCostMinor).toBe(25);
    expect(codex.subscriptionBps).toBe(400);
    expect(codex.liquid).toBeCloseTo(codex.tokenRatio);
    expect(codex.liquid).not.toBeCloseTo(codex.subscriptionRatio);
    expect(vscode.unknownOnly).toBe(true);
    expect(vscode.unknown).toBe(1);
    expect(vscode.percent).toBe("—");
    expect(vscode.caption).toBe("unknown");
  });

  it("counts QA outcomes and today's updates from the fixture tasks", () => {
    const tasks = tasksForProject("usba");
    expect(qaBreakdown(tasks)).toEqual({ accept: 1, rework: 1, unavailable: 1, open: 3 });
    expect(touchSeries(tasks).reduce((sum, count) => sum + count, 0)).toBe(tasks.length);
    const saturday = tasks.find((task) => task.id === "saturday-copy");
    expect(saturday).toBeDefined();
    expect(findingsCount(saturday!)).toBe(1);
    expect(progressIndex("assigned")).toEqual({ index: 1, stalled: false });
    expect(progressIndex("recovery_pending")).toEqual({ index: 2, stalled: true });
    expect(progressIndex("accepted").index).toBe(5);
    expect(progressPercent("accepted")).toBe(100);
    expect(progressPercent("assigned")).toBeLessThan(progressPercent("executing"));
  });
});
