import { encodeAdapterBoard, type AdapterBoardCard } from "@t3tools/ai-os-adapter/board";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { applyAdapterBoardPayload } from "./adapterFeed";
import { OPERATIONS_TASKS } from "./fixtures";
import { OperationsDashboard, ProvideOperationsProjectNames } from "./OperationsDashboard";

const LIVE_PROJECT = "13fdd883-1111-4111-8111-111111111111";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  applyAdapterBoardPayload("[]");
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const projects = (): HTMLSelectElement => {
  const select = document.querySelector('select[aria-label="Projects"]');
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("Missing project menu");
  }
  return select;
};

const choose = async (value: string) => {
  const select = projects();
  select.value = value;
  await act(() => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const liveCard = (): AdapterBoardCard => {
  const sample = OPERATIONS_TASKS[0];
  if (sample === undefined || sample.assignment === null) {
    throw new Error("Missing fixture task");
  }
  return {
    taskId: "live-tournament",
    title: "Live tournament page",
    state: {
      phase: "assigned",
      intake: { ...sample.intake, projectId: LIVE_PROJECT, workspaceId: LIVE_PROJECT },
      assignment: sample.assignment,
    } as AdapterBoardCard["state"],
    threadId: "t3-thread-1",
    updatedAt: "2026-10-21T18:00:00Z",
  };
};

describe("operations project filter", () => {
  it("starts on all projects and filters from the menu", async () => {
    await act(() =>
      root.render(
        <StrictMode>
          <OperationsDashboard />
        </StrictMode>,
      ),
    );

    const select = projects();
    expect(select.value).toBe("all");
    expect(select.selectedOptions[0]?.textContent).toBe("All projects");
    expect(document.querySelector("#board-filter-label")?.textContent).toBe("All projects");
    expect(buttonText("Saturday schedule copy")).toContain("USBA");
    expect(buttonText("Inbox triage")).toContain("Personal");

    await choose("usba");

    expect(projects().value).toBe("usba");
    expect(document.querySelector("#board-filter-label")?.textContent).toBe("USBA");
    expect(buttonText("Saturday schedule copy")).toContain("USBA");
    expect(document.body.textContent).not.toContain("Inbox triage");

    await choose("all");

    expect(projects().value).toBe("all");
    expect(document.querySelector("#board-filter-label")?.textContent).toBe("All projects");
    expect(document.body.textContent).toContain("Inbox triage");
    expect(document.body.textContent).toContain("Saturday schedule copy");
  });

  it("names a live project and hides fixture cards", async () => {
    applyAdapterBoardPayload(encodeAdapterBoard([liveCard()]));
    await act(() =>
      root.render(
        <StrictMode>
          <ProvideOperationsProjectNames names={new Map([[LIVE_PROJECT, "aios-test"]])}>
            <OperationsDashboard />
          </ProvideOperationsProjectNames>
        </StrictMode>,
      ),
    );

    const select = projects();
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "All projects",
      "aios-test",
    ]);
    expect(document.body.textContent).not.toContain(LIVE_PROJECT);
    expect(document.body.textContent).toContain("Live tournament page");
    expect(document.body.textContent).toContain("aios-test");
    expect(document.body.textContent).not.toContain("Inbox triage");
    expect(document.body.textContent).not.toContain("Grok Bot");
    expect(document.querySelector("#board-filter-label")?.textContent).toBe("All projects");

    const demo = document.querySelector('input[aria-label="Demo data"]');
    if (demo instanceof HTMLInputElement) {
      await act(() => {
        demo.click();
      });
      expect(document.body.textContent).toContain("Inbox triage");
    }

    await choose(LIVE_PROJECT);

    expect(document.querySelector("#board-filter-label")?.textContent).toBe("aios-test");
    expect(buttonText("Live tournament page")).toContain("aios-test");
  });
});

const buttonText = (name: string): string => {
  const button = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(name),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${name}`);
  }
  return button.textContent ?? "";
};
