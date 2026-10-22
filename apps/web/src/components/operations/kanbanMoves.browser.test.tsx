import { encodeAdapterBoard, type AdapterBoardCard } from "@t3tools/ai-os-adapter/board";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { applyAdapterBoardPayload, __resetAdapterBoardFeedForTests } from "./adapterFeed";
import { OPERATIONS_TASKS } from "./fixtures";
import { OperationsDashboard } from "./OperationsDashboard";

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
  __resetAdapterBoardFeedForTests();
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hero = () => {
  const sample = OPERATIONS_TASKS.find((task) => task.id === "homepage-hero");
  if (sample === undefined || sample.assignment === null || sample.progress[0] === undefined) {
    throw new Error("Missing executing fixture");
  }
  return sample;
};

const liveCard = (phase: "executing" | "awaiting_qa"): AdapterBoardCard => {
  const sample = hero();
  const progress = sample.progress[0];
  return {
    taskId: "live-hero",
    title: "Live hero",
    state: {
      phase,
      intake: sample.intake,
      assignment: sample.assignment,
      run: { usage: [], progress },
      completion: null,
      qa: null,
    } as unknown as AdapterBoardCard["state"],
    threadId: "t3-thread-1",
    runId: "run-1",
    revision: 2,
    updatedAt: "2026-10-21T18:00:00Z",
  };
};

const renderBoard = async (phase: "executing" | "awaiting_qa" = "executing") => {
  applyAdapterBoardPayload(encodeAdapterBoard([liveCard(phase)]));
  await act(() =>
    root.render(
      <StrictMode>
        <OperationsDashboard />
      </StrictMode>,
    ),
  );
};

const moveSelect = (): HTMLSelectElement => {
  const select = document.querySelector("#move-live-hero");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing move menu");
  return select;
};

const buttonNamed = (name: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === name);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button ${name}`);
  return button;
};

const choose = async (column: string) => {
  const select = moveSelect();
  select.focus();
  select.value = column;
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const tab = (shiftKey: boolean) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
};

describe("operations kanban moves", () => {
  it("keeps the card in progress when Done is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              _tag: "Rejected",
              detail:
                "Done requires a passed independent QA from a different model than the builder.",
            }),
            { status: 409 },
          ),
      ),
    );
    await renderBoard();
    await choose("Done");
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/different model/);
    expect(moveSelect().value).toBe("Running");
    expect(document.querySelector("#column-Running")?.closest("section")?.textContent).toContain(
      "Live hero",
    );
  });

  it("posts one confirmation when Confirm is activated twice", async () => {
    const bodies: Array<{ readonly confirmed?: boolean }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { readonly confirmed?: boolean };
        bodies.push(body);
        if (body.confirmed === true) {
          return new Response(JSON.stringify({ _tag: "Applied", changed: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            _tag: "NeedsConfirmation",
            detail: "Cancel this run and return it to Ready?",
          }),
          { status: 409 },
        );
      }),
    );
    await renderBoard();
    await choose("Ready");
    const confirm = buttonNamed("Confirm");
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(bodies.filter((body) => body.confirmed === true)).toHaveLength(1);
  });

  it("traps focus in the confirmation and restores the move menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              _tag: "NeedsConfirmation",
              detail: "Cancel this run and return it to Ready?",
            }),
            { status: 409 },
          ),
      ),
    );
    await renderBoard();
    const select = moveSelect();
    await choose("Ready");
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(buttonNamed("Confirm"));
    await act(() => tab(true));
    expect(document.activeElement).toBe(buttonNamed("Keep it here"));
    await act(() => tab(false));
    expect(document.activeElement).toBe(buttonNamed("Confirm"));
    await act(() => tab(true));
    expect(document.activeElement).toBe(buttonNamed("Keep it here"));
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(select);
  });

  it("follows a live event that arrives while a move is still in flight", async () => {
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );
    await renderBoard();
    await choose("Done");
    await act(() => {
      applyAdapterBoardPayload(encodeAdapterBoard([liveCard("awaiting_qa")]));
    });
    await act(async () => {
      release?.(
        new Response(
          JSON.stringify({
            _tag: "Rejected",
            detail: "Done requires a passed independent QA from a different model.",
          }),
          { status: 409 },
        ),
      );
    });
    expect(moveSelect().value).toBe("Review");
    expect(document.querySelector("#column-Review")?.closest("section")?.textContent).toContain(
      "Live hero",
    );
    expect(
      document.querySelector("#column-Running")?.closest("section")?.textContent,
    ).not.toContain("Live hero");
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/different model/);
  });
});
