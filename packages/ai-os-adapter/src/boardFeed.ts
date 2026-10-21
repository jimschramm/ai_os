import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { SequenceState } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Queue from "effect/Queue";
// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer takes Node's createServer.
import * as NodeHttp from "node:http";

import { readAdapterBoard, subscribeAdapterFeed, type AdapterBoardCard } from "./grokT3.ts";

/** Local feed the operations board subscribes to. A Grok process serves it. */
export const ADAPTER_BOARD_ORIGIN = "http://127.0.0.1:3788";
export const ADAPTER_BOARD_PATH = "/ai-os/board";
export const ADAPTER_BOARD_EVENTS_PATH = "/ai-os/board/events";

const BoardCards = Schema.Array(
  Schema.Struct({
    taskId: Schema.String,
    title: Schema.String,
    state: SequenceState,
    threadId: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
  }),
);

const encodeBoard = Schema.encodeSync(Schema.fromJsonString(BoardCards));
const decodeBoard = Schema.decodeUnknownSync(Schema.fromJsonString(BoardCards));

export const encodeAdapterBoard = (cards: readonly AdapterBoardCard[]): string =>
  encodeBoard(cards);

export const decodeAdapterBoard = (text: string): readonly AdapterBoardCard[] | null => {
  try {
    return decodeBoard(text);
  } catch {
    return null;
  }
};

const frame = (cards: readonly AdapterBoardCard[]) =>
  new TextEncoder().encode(`data: ${encodeAdapterBoard(cards)}\n\n`);

const pathname = (url: string): string => {
  try {
    return new URL(url, ADAPTER_BOARD_ORIGIN).pathname;
  } catch {
    return url.split("?")[0] ?? "/";
  }
};

const events = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Uint8Array>();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      Queue.offerUnsafe(queue, frame(readAdapterBoard()));
      return subscribeAdapterFeed(() => {
        Queue.offerUnsafe(queue, frame(readAdapterBoard()));
      });
    }),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  return HttpServerResponse.stream(Stream.fromQueue(queue), {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" },
  });
});

/** HTTP handler for the board snapshot and its server-sent-event feed. */
export const adapterBoardHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = pathname(request.url);
  if (request.method === "GET" && path === ADAPTER_BOARD_EVENTS_PATH) {
    return yield* events;
  }
  if (request.method === "GET" && path === ADAPTER_BOARD_PATH) {
    return HttpServerResponse.text(encodeAdapterBoard(readAdapterBoard()), {
      contentType: "application/json",
    });
  }
  return HttpServerResponse.empty({ status: 404 });
});

/** Listen on {@link ADAPTER_BOARD_ORIGIN} so the web app can subscribe from another process. */
export const adapterBoardLayer = HttpServer.serve(adapterBoardHandler).pipe(
  Layer.provideMerge(
    NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 3788 }),
  ),
);
