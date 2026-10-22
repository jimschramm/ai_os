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

describe("operations project filter", () => {
  it("starts on all projects and filters without hiding the other chips", async () => {
    await act(() =>
      root.render(
        <StrictMode>
          <OperationsDashboard />
        </StrictMode>,
      ),
    );

    const all = buttonNamed("All");
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("Saturday schedule copy").textContent).toContain("USBA");
    expect(buttonNamed("Inbox triage").textContent).toContain("Personal");
    expect(buttonNamed("Local contract check").textContent).toContain("ai_os");

    await act(() => buttonNamed("USBA").click());

    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(buttonNamed("USBA").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("Saturday schedule copy").textContent).toContain("USBA");
    expect(document.body.textContent).not.toContain("Inbox triage");
    expect(document.body.textContent).toContain("Personal");

    await act(() => all.click());

    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Inbox triage");
    expect(document.body.textContent).toContain("Saturday schedule copy");
  });
});
