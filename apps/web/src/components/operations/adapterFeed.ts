import {
  ADAPTER_BOARD_EVENTS_PATH,
  decodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import { useSyncExternalStore } from "react";

import { primaryFetchInit } from "../../environments/primary/primaryRequest";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const EMPTY: readonly AdapterBoardCard[] = [];

// A live response starts this over. Repeated failures climb until the cap.
const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;

let snapshot: readonly AdapterBoardCard[] = EMPTY;
const listeners = new Set<() => void>();
let attempt = 0;
let feedStarted = false;
let abortController: AbortController | null = null;
let cancelWait: (() => void) | null = null;
let backoffIndex = 0;

export interface AdapterBoardFeedClient {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly schedule: (delayMs: number, run: () => void) => () => void;
}

let feedClient: AdapterBoardFeedClient | null = null;

export const readAdapterBoardSnapshot = (): readonly AdapterBoardCard[] => snapshot;

/** Apply one feed payload. Returns false when the payload is not board state. */
export const applyAdapterBoardPayload = (text: string): boolean => {
  const next = decodeAdapterBoard(text);
  if (next === null) return false;
  snapshot = next;
  for (const listener of listeners) listener();
  return true;
};

export const __setAdapterBoardFeedForTests = (client: AdapterBoardFeedClient | null): void => {
  feedClient = client;
};

export const __resetAdapterBoardFeedForTests = (): void => {
  listeners.clear();
  stopFeed();
  feedClient = null;
  snapshot = EMPTY;
};

const boardUrl = (): string | null => {
  try {
    return resolvePrimaryEnvironmentHttpUrl(ADAPTER_BOARD_EVENTS_PATH);
  } catch {
    return null;
  }
};

const fetchBoard = (url: string, init: RequestInit): Promise<Response> =>
  (feedClient?.fetch ?? globalThis.fetch.bind(globalThis))(url, init);

const scheduleDelay = (delayMs: number, run: () => void): (() => void) => {
  if (feedClient) return feedClient.schedule(delayMs, run);
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

const stopFeed = (): void => {
  attempt += 1;
  feedStarted = false;
  backoffIndex = 0;
  const cancel = cancelWait;
  cancelWait = null;
  abortController?.abort();
  abortController = null;
  cancel?.();
};

const nextDelay = (): number => {
  const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
  backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
  return delay;
};

const waitForRetry = (token: number, delayMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      cancelWait = null;
      resolve(ready && token === attempt);
    };
    const cancelTimer = scheduleDelay(delayMs, () => finish(true));
    cancelWait = () => {
      cancelTimer();
      finish(false);
    };
  });

const applyFrame = (frame: string): void => {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
    .join("\n");
  if (data.length === 0) return;
  applyAdapterBoardPayload(data);
};

type FeedStep = "retry" | "stop";

const readFeed = async (token: number, url: string): Promise<FeedStep> => {
  const controller = new AbortController();
  abortController = controller;
  try {
    const init = await primaryFetchInit();
    if (token !== attempt || listeners.size === 0) return "stop";
    const headers = new Headers(init.headers);
    headers.set("accept", "text/event-stream");
    const response = await fetchBoard(url, {
      headers,
      signal: controller.signal,
      ...(init.credentials ? { credentials: init.credentials } : {}),
    });
    if (token !== attempt || controller.signal.aborted) return "stop";
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return "retry";
    }

    // The server sends the current snapshot as the first frame, so a reconnect
    // replaces a stale board instead of appending to it.
    backoffIndex = 0;
    const reader = response.body.getReader();
    const onAbort = () => {
      void reader.cancel(controller.signal.reason).catch(() => undefined);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (listeners.size > 0) {
        if (token !== attempt) return "stop";
        const { done, value } = await reader.read();
        if (token !== attempt || controller.signal.aborted) return "stop";
        if (done) return "retry";
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) applyFrame(frame);
      }
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
    return "stop";
  } catch {
    if (token !== attempt || controller.signal.aborted) return "stop";
    return "retry";
  } finally {
    if (abortController === controller) abortController = null;
  }
};

const runFeed = async (token: number): Promise<void> => {
  try {
    while (listeners.size > 0) {
      if (token !== attempt) return;
      const url = boardUrl();
      if (url === null) return;
      const step = await readFeed(token, url);
      if (token !== attempt || listeners.size === 0 || step === "stop") return;
      const ready = await waitForRetry(token, nextDelay());
      if (!ready || token !== attempt || listeners.size === 0) return;
    }
  } finally {
    if (token === attempt) feedStarted = false;
  }
};

const ensureFeed = (): void => {
  if (feedStarted) return;
  // Dialog and board unit tests subscribe while rendering. They opt in with a
  // fake client when they want the socket.
  if (import.meta.env.MODE === "test" && feedClient === null) return;
  if (boardUrl() === null) return;
  feedStarted = true;
  void runFeed(attempt);
};

export const subscribeAdapterBoard = (listener: () => void): (() => void) => {
  listeners.add(listener);
  ensureFeed();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopFeed();
  };
};

export const useAdapterBoard = (): readonly AdapterBoardCard[] =>
  useSyncExternalStore(subscribeAdapterBoard, readAdapterBoardSnapshot, () => EMPTY);
