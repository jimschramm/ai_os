import { ContractId, ContractText, IsoDateTime, SequenceState } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";
import * as Queue from "effect/Queue";

import { encodeAdapterBoard, type AdapterBoardCard } from "./board.ts";

const WireCards = Schema.Array(
  Schema.Struct({
    taskId: ContractId,
    title: ContractText,
    state: SequenceState,
    threadId: Schema.NullOr(ContractId),
    updatedAt: IsoDateTime,
  }),
);

const encodeWire = Schema.encodeSync(Schema.fromJsonString(WireCards));
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(WireCards));

/** Strict snapshot the T3 server stores. The browser decodes a looser copy. */
export const encodeAdapterBoardWire = (cards: readonly AdapterBoardCard[]): string =>
  encodeWire(cards);

export interface AdapterBoardHub {
  readonly snapshot: () => string;
  /** Replace the snapshot. Used when a saved file is loaded. */
  readonly replace: (text: string) => boolean;
  /** Insert or update each card by task id. Cards not in the payload stay. */
  readonly upsert: (text: string) => boolean;
  readonly events: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope>;
}

const encoder = new TextEncoder();

const frame = (json: string) => encoder.encode(`data: ${json}\n\n`);

type WireCard = (typeof WireCards.Type)[number];

const decodeCards = (text: string): readonly WireCard[] | null => {
  try {
    return decodeWire(text);
  } catch {
    return null;
  }
};

/** In-memory snapshot and server-sent-event fanout. Callers authenticate first. */
export const makeAdapterBoardHub = (): AdapterBoardHub => {
  let snapshot = encodeAdapterBoard([]);
  const listeners = new Set<(next: Uint8Array) => void>();
  const publish = (json: string) => {
    snapshot = json;
    const next = frame(json);
    for (const listener of listeners) listener(next);
  };
  const write = (cards: readonly WireCard[]) => {
    publish(encodeWire(cards));
  };
  return {
    snapshot: () => snapshot,
    replace: (text) => {
      const cards = decodeCards(text);
      if (cards === null) return false;
      write(cards);
      return true;
    },
    upsert: (text) => {
      const incoming = decodeCards(text);
      if (incoming === null) return false;
      const current = decodeCards(snapshot) ?? [];
      const merged = new Map<string, WireCard>();
      for (const card of current) merged.set(card.taskId, card);
      for (const card of incoming) merged.set(card.taskId, card);
      const order: WireCard[] = [];
      const seen = new Set<string>();
      for (const card of current) {
        const next = merged.get(card.taskId);
        if (next === undefined) continue;
        order.push(next);
        seen.add(card.taskId);
      }
      for (const card of incoming) {
        if (seen.has(card.taskId)) continue;
        const next = merged.get(card.taskId);
        if (next === undefined) continue;
        order.push(next);
        seen.add(card.taskId);
      }
      write(order);
      return true;
    },
    events: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerUnsafe(queue, frame(snapshot));
          const listener = (next: Uint8Array) => {
            Queue.offerUnsafe(queue, next);
          };
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      return HttpServerResponse.stream(Stream.fromQueue(queue), {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
      });
    }),
  };
};
