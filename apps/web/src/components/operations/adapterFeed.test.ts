import { encodeAdapterBoard, type AdapterBoardCard } from "@t3tools/ai-os-adapter/board";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetDesktopPrimaryAuthForTests } from "../../environments/primary/desktopAuth";
import {
  __resetAdapterBoardFeedForTests,
  __setAdapterBoardFeedForTests,
  readAdapterBoardSnapshot,
  subscribeAdapterBoard,
  type AdapterBoardFeedClient,
} from "./adapterFeed";

const updatedAt = "2026-10-21T18:00:00Z";

const boardJson = (taskId: string, title: string): string =>
  encodeAdapterBoard([
    {
      taskId,
      title,
      state: {} as AdapterBoardCard["state"],
      threadId: null,
      updatedAt,
    },
  ]);

const frame = (json: string): Uint8Array => new TextEncoder().encode(`data: ${json}\n\n`);

const splitFrame = (json: string): readonly [Uint8Array, Uint8Array] => {
  const bytes = frame(json);
  const midpoint = Math.max(1, Math.floor(bytes.length / 2));
  return [bytes.subarray(0, midpoint), bytes.subarray(midpoint)];
};

const droppedStream = (parts: readonly (Uint8Array | "error")[]): ReadableStream<Uint8Array> => {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) {
        controller.close();
        return;
      }
      if (part === "error") {
        controller.error(new Error("socket dropped"));
        return;
      }
      controller.enqueue(part);
    },
  });
};

const installWindow = (kind: "cookie" | "bearer"): void => {
  vi.stubEnv("VITE_HTTP_URL", "");
  vi.stubEnv("VITE_WS_URL", "");
  vi.stubEnv("VITE_DEV_SERVER_URL", "");
  vi.stubGlobal("window", {
    location: {
      href: "http://127.0.0.1:3773/settings",
      origin: "http://127.0.0.1:3773",
    },
    ...(kind === "bearer"
      ? {
          desktopBridge: {
            getLocalEnvironmentBootstraps: () => [],
            getLocalEnvironmentBearerToken: () => Promise.resolve("desktop-bearer-token"),
          },
        }
      : {}),
  });
};

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 40; tick += 1) await Promise.resolve();
};

describe("adapter board feed", () => {
  afterEach(() => {
    __resetAdapterBoardFeedForTests();
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends cookies for a same-origin page, then resyncs after the stream drops", async () => {
    installWindow("cookie");
    const seen: string[][] = [];
    const calls: RequestInit[] = [];
    const pending: Array<{ delayMs: number; run: () => void }> = [];
    const [firstHalf, secondHalf] = splitFrame(boardJson("task-a", "Page A"));
    const responses: Array<() => Response | Promise<Response>> = [
      () => new Response(boardJson("ignored", "Ignored"), { status: 401 }),
      () => Promise.reject(new Error("offline")),
      () =>
        new Response(droppedStream([firstHalf, secondHalf, "error"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(frame(boardJson("task-b", "Page B")));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ];
    const client: AdapterBoardFeedClient = {
      fetch: (url, init) => {
        expect(url).toBe("http://127.0.0.1:3773/api/ai-os/board/events");
        calls.push(init);
        const next = responses.shift();
        if (!next) return Promise.reject(new Error("unexpected board fetch"));
        return Promise.resolve(next());
      },
      schedule: (delayMs, run) => {
        const entry = { delayMs, run };
        pending.push(entry);
        return () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        };
      },
    };
    __setAdapterBoardFeedForTests(client);

    const stopFirst = subscribeAdapterBoard(() => {
      seen.push(readAdapterBoardSnapshot().map((card) => card.taskId));
    });
    await settle();
    expect(readAdapterBoardSnapshot()).toEqual([]);
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.credentials).toBe("include");
    expect(new Headers(calls[0]?.headers).get("authorization")).toBeNull();
    expect(new Headers(calls[0]?.headers).get("accept")).toBe("text/event-stream");
    expect(pending.map((entry) => entry.delayMs)).toEqual([250]);

    pending.shift()?.run();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.credentials).toBe("include");
    expect(pending.map((entry) => entry.delayMs)).toEqual([500]);

    pending.shift()?.run();
    await settle();
    expect(readAdapterBoardSnapshot().map((card) => card.taskId)).toEqual(["task-a"]);
    expect(seen).toEqual([["task-a"]]);
    expect(pending.map((entry) => entry.delayMs)).toEqual([250]);

    const stopSecond = subscribeAdapterBoard(() => undefined);
    pending.shift()?.run();
    await settle();
    expect(readAdapterBoardSnapshot().map((card) => card.title)).toEqual(["Page B"]);
    expect(seen).toEqual([["task-a"], ["task-b"]]);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.signal?.aborted).toBe(false);

    stopFirst();
    expect(calls[3]?.signal?.aborted).toBe(false);
    expect(pending).toEqual([]);
    stopSecond();
    await settle();
    expect(calls[3]?.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(4);
    expect(pending).toEqual([]);
  });

  it("sends the desktop bearer and stops reconnecting with the last subscriber", async () => {
    installWindow("bearer");
    const calls: RequestInit[] = [];
    const pending: Array<{ delayMs: number; run: () => void }> = [];
    let cancelled = false;
    const responses: Array<() => Response | Promise<Response>> = [
      () => Promise.reject(new Error("server restarted")),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(frame(boardJson("task-b", "Recovered")));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ];
    const client: AdapterBoardFeedClient = {
      fetch: (_url, init) => {
        calls.push(init);
        const next = responses.shift();
        if (!next) return Promise.reject(new Error("unexpected board fetch"));
        return Promise.resolve(next());
      },
      schedule: (delayMs, run) => {
        const entry = { delayMs, run };
        pending.push(entry);
        return () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        };
      },
    };
    __setAdapterBoardFeedForTests(client);

    const stopFirst = subscribeAdapterBoard(() => undefined);
    await settle();
    expect(pending.map((entry) => entry.delayMs)).toEqual([250]);
    expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer desktop-bearer-token");
    expect(calls[0]?.credentials).toBe("omit");

    const stopSecond = subscribeAdapterBoard(() => undefined);
    stopFirst();
    expect(pending).toHaveLength(1);
    pending.shift()?.run();
    await settle();
    expect(readAdapterBoardSnapshot().map((card) => card.title)).toEqual(["Recovered"]);
    expect(calls[1]?.credentials).toBe("omit");
    expect(new Headers(calls[1]?.headers).get("authorization")).toBe("Bearer desktop-bearer-token");

    stopSecond();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(pending).toEqual([]);
  });
});
