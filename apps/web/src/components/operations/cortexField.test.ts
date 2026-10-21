import { describe, expect, it } from "vite-plus/test";

import { MEMORY_GRAPH } from "./memoryFixtures";
import { INITIAL_MEMORY_REVIEW } from "./memoryModel";
import {
  CLUSTER_KINDS,
  CORTEX_LINK_COUNT,
  CORTEX_NODE_COUNT,
  FULL_SHOWN,
  MEMORY_SOURCES,
  defaultSourceToggles,
  memorySourceFor,
  neuralField,
  timelineField,
} from "./cortexField";

const enabled = new Set(Object.keys(defaultSourceToggles()));

describe("cortex field", () => {
  it("keeps the catalog at 4,999 nodes and 7,240 links", () => {
    expect(CLUSTER_KINDS.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(CORTEX_NODE_COUNT);
    expect(MEMORY_SOURCES.reduce((sum, source) => sum + source.count, 0)).toBe(CORTEX_NODE_COUNT);
    expect(CORTEX_NODE_COUNT).toBe(4999);
    expect(CORTEX_LINK_COUNT).toBe(7240);
  });

  it("maps every fact except the project hub to a source", () => {
    const missing = MEMORY_GRAPH.facts.flatMap((fact) =>
      fact.kind === "Project" || memorySourceFor(fact.factId) !== null ? [] : [fact.factId],
    );
    expect(missing).toEqual([]);
  });

  it("shows 162 nodes at full detail and no satellites at macro", () => {
    const full = neuralField({
      projectId: "usba",
      review: INITIAL_MEMORY_REVIEW,
      level: "full",
      enabledSources: enabled,
      query: "",
    });
    expect(full.shown).toBe(FULL_SHOWN);
    expect(full.records.some((record) => record.factId === "fact-friday-7")).toBe(true);
    expect(full.records.some((record) => record.factId === "fact-saturday-start")).toBe(true);
    const macro = neuralField({
      projectId: "usba",
      review: INITIAL_MEMORY_REVIEW,
      level: "macro",
      enabledSources: enabled,
      query: "",
    });
    expect(macro.satellites).toEqual([]);
    expect(macro.shown).toBe(CLUSTER_KINDS.length + macro.records.length);
  });

  it("draws the Friday conflict and the Saturday supersession", () => {
    const field = neuralField({
      projectId: "usba",
      review: INITIAL_MEMORY_REVIEW,
      level: "full",
      enabledSources: enabled,
      query: "",
    });
    const conflicting = field.records
      .filter((record) => record.conflicting)
      .map((record) => record.factId);
    expect(conflicting.sort()).toEqual(["fact-friday-6", "fact-friday-7"]);
    expect(field.arcs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conflict",
          fromId: "fact-friday-7",
          toId: "fact-friday-6",
        }),
        expect.objectContaining({
          kind: "supersede",
          fromId: "fact-saturday-start",
          toId: "fact-saturday-830",
        }),
      ]),
    );
    const oldSaturday = field.records.find((record) => record.factId === "fact-saturday-830");
    expect(oldSaturday?.dimmed).toBe(true);
    const rejected = field.records.find((record) => record.factId === "fact-banner-proposed");
    expect(rejected?.status).toBe("rejected");
  });

  it("drops a source's satellites and records when that source is off", () => {
    const withoutGrok = new Set([...enabled].filter((id) => id !== "grok-bot"));
    const field = neuralField({
      projectId: "usba",
      review: INITIAL_MEMORY_REVIEW,
      level: "full",
      enabledSources: withoutGrok,
      query: "",
    });
    expect(field.shown).toBeLessThan(FULL_SHOWN);
    expect(field.satellites.some((dot) => dot.sourceId === "grok-bot")).toBe(false);
    expect(field.records.some((record) => record.factId === "fact-friday-6")).toBe(false);
    expect(field.records.some((record) => record.factId === "fact-friday-7")).toBe(true);
    expect(field.arcs.some((arc) => arc.kind === "conflict")).toBe(false);
  });

  it("orders the Saturday versions along the timeline", () => {
    const timeline = timelineField({
      projectId: "usba",
      review: INITIAL_MEMORY_REVIEW,
      enabledSources: enabled,
      query: "",
    });
    const older = timeline.nodes.find((node) => node.factId === "fact-saturday-830");
    const newer = timeline.nodes.find((node) => node.factId === "fact-saturday-start");
    expect(older).toBeDefined();
    expect(newer).toBeDefined();
    expect(older!.x).toBeLessThan(newer!.x);
    expect(timeline.arcs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromId: "fact-saturday-start", toId: "fact-saturday-830" }),
      ]),
    );
  });
});
