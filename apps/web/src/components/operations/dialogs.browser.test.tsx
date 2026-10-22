import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { OperationsDashboard } from "./OperationsDashboard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.height = "100vh";
  container.style.width = "100%";
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

const renderDashboard = () =>
  act(() =>
    root.render(
      <StrictMode>
        <OperationsDashboard />
      </StrictMode>,
    ),
  );

const contentMain = (): HTMLElement => {
  const main = container.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    throw new Error("Missing operations content");
  }
  return main;
};

const drawerNamed = (label: string): HTMLElement => {
  const drawer = document.querySelector(`aside[aria-labelledby="${label}"]`);
  if (!(drawer instanceof HTMLElement)) {
    throw new Error(`Missing drawer ${label}`);
  }
  return drawer;
};

const closeDrawer = async (drawer: HTMLElement) => {
  const close = [...drawer.querySelectorAll("button")].find((item) => item.textContent === "Close");
  if (!(close instanceof HTMLButtonElement)) {
    throw new Error("Missing close button");
  }
  await act(() => close.click());
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(undefined));
    });
    await Promise.all(drawer.getAnimations().map((animation) => animation.finished));
  });
};

const pageFrame = () => {
  const shell = container.firstElementChild;
  if (!(shell instanceof HTMLElement)) {
    throw new Error("Missing operations shell");
  }
  return {
    mainX: contentMain().getBoundingClientRect().x,
    scrollWidth: document.documentElement.scrollWidth,
    edge: shell.getBoundingClientRect().right,
  };
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

  it("closes the memory drawer fully offscreen without shifting the page", async () => {
    await renderDashboard();
    const before = pageFrame();
    const opener = buttonNamed("Browse memory");
    opener.focus();
    await act(() => opener.click());
    const drawer = drawerNamed("memory-browser-title");
    await closeDrawer(drawer);

    const rect = drawer.getBoundingClientRect();
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(rect.left).toBeGreaterThanOrEqual(before.edge - 1);
    expect(rect.right).toBeGreaterThan(before.edge);
    const after = pageFrame();
    expect(after.mainX).toBe(before.mainX);
    expect(after.scrollWidth).toBe(before.scrollWidth);
    expect(after.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(document.documentElement.scrollLeft).toBe(0);
  });

  it("closes the task drawer fully offscreen without shifting the page", async () => {
    await renderDashboard();
    const before = pageFrame();
    const opener = buttonNamed("Saturday schedule copy");
    opener.focus();
    await act(() => opener.click());
    const drawer = drawerNamed("task-drawer-title");
    await closeDrawer(drawer);

    const rect = drawer.getBoundingClientRect();
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(rect.left).toBeGreaterThanOrEqual(before.edge - 1);
    const after = pageFrame();
    expect(after.mainX).toBe(before.mainX);
    expect(after.scrollWidth).toBe(before.scrollWidth);
    expect(after.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(document.documentElement.scrollLeft).toBe(0);
  });
});
