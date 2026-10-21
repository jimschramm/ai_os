import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const buttonNamed = (name: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(name),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${name}`);
  }
  return button;
};

const openDialog = (): HTMLElement => {
  const dialog = document.querySelector('[role="dialog"][aria-hidden="false"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Dialog is closed");
  }
  return dialog;
};

const tab = (shiftKey: boolean) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
};

describe("operations dialogs", () => {
  it("keeps task drawer focus inside the trap and returns it to the opener", async () => {
    await act(() =>
      root.render(
        <StrictMode>
          <OperationsDashboard />
        </StrictMode>,
      ),
    );
    const opener = buttonNamed("Saturday schedule copy");
    opener.focus();
    await act(() => opener.click());

    const dialog = openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector("#task-drawer-title"));

    await act(() => tab(true));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).not.toBe(dialog.querySelector("#task-drawer-title"));

    await act(() => tab(false));
    expect(document.activeElement).toBe(dialog.querySelector("#task-drawer-title"));

    const close = [...dialog.querySelectorAll("button")].find(
      (item) => item.textContent === "Close",
    );
    if (!(close instanceof HTMLButtonElement)) {
      throw new Error("Missing close button");
    }
    await act(() => close.click());
    expect(document.activeElement).toBe(opener);
  });

  it("keeps memory browser focus inside the trap and returns it to the opener", async () => {
    await act(() =>
      root.render(
        <StrictMode>
          <OperationsDashboard />
        </StrictMode>,
      ),
    );
    const opener = buttonNamed("Browse memory");
    opener.focus();
    await act(() => opener.click());

    const dialog = openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector("#memory-browser-title"));

    await act(() => tab(true));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).not.toBe(dialog.querySelector("#memory-browser-title"));

    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).toBe(opener);
  });
});
