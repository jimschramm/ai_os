import {
  ADAPTER_BOARD_EVENTS_PATH,
  ADAPTER_BOARD_ORIGIN,
  decodeAdapterBoard,
  type AdapterBoardCard,
} from "@t3tools/ai-os-adapter";
import { useSyncExternalStore } from "react";

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

const ensureFeed = () => {
  if (source !== null || import.meta.env.MODE === "test") return;
  source = new EventSource(`${ADAPTER_BOARD_ORIGIN}${ADAPTER_BOARD_EVENTS_PATH}`);
  source.addEventListener("message", (event) => {
    applyAdapterBoardPayload(String(event.data));
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
