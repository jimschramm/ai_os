import {
  ADAPTER_BOARD_EVENTS_PATH,
  decodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter/board";
import { useSyncExternalStore } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const EMPTY: readonly AdapterBoardCard[] = [];

let snapshot: readonly AdapterBoardCard[] = EMPTY;
const listeners = new Set<() => void>();
let source: EventSource | null = null;

export const readAdapterBoardSnapshot = (): readonly AdapterBoardCard[] => snapshot;

/** Apply one feed payload. Returns false when the payload is not board state. */
export const applyAdapterBoardPayload = (text: string): boolean => {
  const next = decodeAdapterBoard(text);
  if (next === null) return false;
  snapshot = next;
  for (const listener of listeners) listener();
  return true;
};

const boardUrl = (): string | null => {
  try {
    return resolvePrimaryEnvironmentHttpUrl(ADAPTER_BOARD_EVENTS_PATH);
  } catch {
    return null;
  }
};

const ensureFeed = () => {
  if (source !== null || import.meta.env.MODE === "test") return;
  const url = boardUrl();
  if (url === null) return;
  // Cookies authenticate the same-origin feed. A rejected stream stops instead
  // of reconnecting, and the dashboard keeps its fixture tasks.
  const events = new EventSource(url, { withCredentials: true });
  source = events;
  events.addEventListener("message", (event) => {
    applyAdapterBoardPayload(String(event.data));
  });
  events.addEventListener("error", () => {
    events.close();
    if (source === events) source = null;
  });
};

export const subscribeAdapterBoard = (listener: () => void): (() => void) => {
  listeners.add(listener);
  ensureFeed();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source !== null) {
      source.close();
      source = null;
    }
  };
};

export const useAdapterBoard = (): readonly AdapterBoardCard[] =>
  useSyncExternalStore(subscribeAdapterBoard, readAdapterBoardSnapshot, () => EMPTY);
