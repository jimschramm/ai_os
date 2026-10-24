import {
  applyBoardWorkflowEvent,
  ContractId,
  ContractText,
  IsoDateTime,
  openBoardTask,
  SequenceEvent,
  SequenceState,
  AttemptMemoryActivityV1,
  type KanbanMoveLedger,
} from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";
import * as Queue from "effect/Queue";

import { encodeAdapterBoard, type AdapterBoardCard } from "./board.ts";

// T3 thread and run ids are entity ids. They contain ":" and "%" and can
// exceed a contract id, so the board stores them as runtime ids.
const RuntimeId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value: string) =>
    value === value.trim() && !/\s/u.test(value) ? true : "Expected a runtime id.",
  ),
);

const WireCards = Schema.Array(
  Schema.Struct({
    taskId: ContractId,
    title: ContractText,
    state: SequenceState,
    threadId: Schema.NullOr(RuntimeId),
    runId: Schema.NullOr(RuntimeId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
      Schema.withDecodingDefault(Effect.succeed(0)),
    ),
    updatedAt: IsoDateTime,
    attempts: Schema.optional(Schema.Array(AttemptMemoryActivityV1)),
  }),
);

export type AdapterBoardWrite = "ok" | "invalid" | "stale" | "forbidden";

const sameState = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const encodeWire = Schema.encodeSync(Schema.fromJsonString(WireCards));
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(WireCards));

/** Strict snapshot the T3 server stores. The browser decodes a looser copy. */
export const encodeAdapterBoardWire = (cards: readonly AdapterBoardCard[]): string =>
  encodeWire(
    cards.map((card) => ({
      taskId: card.taskId,
      title: card.title,
      state: card.state,
      threadId: card.threadId,
      runId: card.runId ?? null,
      revision: card.revision ?? 0,
      updatedAt: card.updatedAt,
      ...(card.attempts === undefined ? {} : { attempts: card.attempts }),
    })),
  );

export interface AdapterBoardHub {
  readonly snapshot: () => string;
  /** Replace the snapshot. Used when a saved file is loaded. */
  readonly replace: (text: string) => boolean;
  /**
   * Update metadata on cards that are already stored. A new card, a stale
   * revision, or a phase change writes nothing. Cards missing from the payload
   * stay. Intake, acknowledge, and assign arrive as workflow events.
   */
  readonly upsert: (text: string) => AdapterBoardWrite;
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

/** Strict decode. The loose board decoder does not turn model strings back into model objects. */
export const decodeAdapterBoardWire = (text: string): readonly AdapterBoardCard[] | null => {
  const cards = decodeCards(text);
  if (cards === null) return null;
  return cards.map((card) => ({
    taskId: card.taskId,
    title: card.title,
    state: card.state,
    threadId: card.threadId,
    runId: card.runId,
    revision: card.revision,
    updatedAt: card.updatedAt,
    ...(card.attempts === undefined ? {} : { attempts: card.attempts }),
  }));
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
      if (incoming === null) return "invalid";
      if (incoming.length === 0) return "ok";
      const current = decodeCards(snapshot) ?? [];
      const stored = new Map(current.map((card) => [card.taskId, card]));
      const planned = new Map<string, WireCard>();
      for (const card of incoming) {
        const previous = stored.get(card.taskId);
        if (previous === undefined) return "forbidden";
        if (card.revision !== previous.revision) return "stale";
        if (!sameState(card.state, previous.state)) return "forbidden";
        const changed =
          card.title !== previous.title ||
          card.threadId !== previous.threadId ||
          card.runId !== previous.runId ||
          card.updatedAt !== previous.updatedAt;
        planned.set(card.taskId, changed ? { ...card, revision: previous.revision + 1 } : previous);
      }
      const order: WireCard[] = [];
      const seen = new Set<string>();
      for (const card of current) {
        order.push(planned.get(card.taskId) ?? card);
        seen.add(card.taskId);
      }
      for (const card of incoming) {
        if (seen.has(card.taskId)) continue;
        const next = planned.get(card.taskId);
        if (next === undefined) continue;
        order.push(next);
        seen.add(card.taskId);
      }
      write(order);
      return "ok";
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

const decodeEvent = Schema.decodeUnknownSync(SequenceEvent);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const readJson = (text: string): unknown => {
  try {
    return decodeJson(text);
  } catch {
    return null;
  }
};

const eventBody = (body: Record<string, unknown>): string => encodeJson(body);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface BoardEventReceipt {
  readonly ledger: KanbanMoveLedger;
  readonly status: number;
  readonly body: string;
}

/** Apply one workflow event onto the hub. Snapshots cannot do this. */
export const acceptBoardEvent = (
  hub: AdapterBoardHub,
  ledger: KanbanMoveLedger,
  text: string,
  updatedAt: string,
): Effect.Effect<BoardEventReceipt> =>
  Effect.gen(function* () {
    const parsed = readJson(text);
    if (parsed === null) {
      return {
        ledger,
        status: 400,
        body: eventBody({ detail: "Expected a JSON object." }),
      };
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.idempotencyKey !== "string"
    ) {
      return {
        ledger,
        status: 400,
        body: eventBody({ detail: "Expected taskId, idempotencyKey, and event." }),
      };
    }
    const event = yield* Effect.try({
      try: () => decodeEvent(parsed.event),
      catch: () => "invalid" as const,
    }).pipe(Effect.orElseSucceed(() => null));
    if (event === null) {
      return { ledger, status: 400, body: eventBody({ detail: "The event is not valid." }) };
    }
    const taskId = parsed.taskId;
    const idempotencyKey = parsed.idempotencyKey;
    const current = decodeCards(hub.snapshot()) ?? [];
    const existing = current.find((card) => card.taskId === taskId);
    const outcome =
      existing === undefined
        ? yield* openBoardTask(event, idempotencyKey, taskId, ledger)
        : yield* applyBoardWorkflowEvent(existing.state, event, idempotencyKey, taskId, ledger);
    if (outcome._tag !== "Applied") {
      return {
        ledger,
        status: 409,
        body: eventBody({ _tag: "Rejected", detail: outcome.detail }),
      };
    }
    const revision = (existing?.revision ?? 0) + (outcome.changed ? 1 : 0);
    if (outcome.changed) {
      const title = existing?.title ?? (typeof parsed.title === "string" ? parsed.title : null);
      if (title === null) {
        return {
          ledger,
          status: 400,
          body: eventBody({ detail: "A new task needs a title." }),
        };
      }
      const threadId =
        typeof parsed.threadId === "string"
          ? parsed.threadId
          : parsed.threadId === null
            ? null
            : (existing?.threadId ?? null);
      const runId =
        typeof parsed.runId === "string"
          ? parsed.runId
          : parsed.runId === null
            ? null
            : (existing?.runId ?? null);
      const nextCard: WireCard = {
        taskId,
        title,
        state: outcome.state,
        threadId,
        runId,
        revision,
        updatedAt,
      };
      const order =
        existing === undefined
          ? [...current, nextCard]
          : current.map((card) => (card.taskId === taskId ? nextCard : card));
      const stored = yield* Effect.try({
        try: () => hub.replace(encodeWire(order)),
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false));
      if (!stored) {
        return {
          ledger,
          status: 400,
          body: eventBody({ detail: "The task could not be stored." }),
        };
      }
    }
    return {
      ledger: outcome.ledger,
      status: 200,
      body: eventBody({ _tag: "Applied", changed: outcome.changed, revision }),
    };
  });
