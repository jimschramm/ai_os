import { SequenceState } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";
import * as Queue from "effect/Queue";

import { encodeAdapterBoard, type AdapterBoardCard } from "./board.ts";

const WireCards = Schema.Array(
  Schema.Struct({
    taskId: Schema.String,
    title: Schema.String,
    state: SequenceState,
    threadId: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
  }),
);

const encodeWire = Schema.encodeSync(Schema.fromJsonString(WireCards));
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(WireCards));

/** Strict snapshot the T3 server stores. The browser decodes a looser copy. */
export const encodeAdapterBoardWire = (cards: readonly AdapterBoardCard[]): string =>
  encodeWire(cards);

export interface AdapterBoardHub {
  readonly snapshot: () => string;
  readonly replace: (text: string) => boolean;
  readonly events: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope>;
}

const encoder = new TextEncoder();

const frame = (json: string) => encoder.encode(`data: ${json}\n\n`);

/** In-memory snapshot and server-sent-event fanout. Callers authenticate first. */
export const makeAdapterBoardHub = (): AdapterBoardHub => {
  let snapshot = encodeAdapterBoard([]);
  const listeners = new Set<(next: Uint8Array) => void>();
  const publish = (json: string) => {
    snapshot = json;
    const next = frame(json);
    for (const listener of listeners) listener(next);
  };
  return {
    snapshot: () => snapshot,
    replace: (text) => {
      try {
        publish(encodeWire(decodeWire(text)));
        return true;
      } catch {
        return false;
      }
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
