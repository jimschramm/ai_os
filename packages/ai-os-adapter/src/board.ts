import type { SequenceState } from "@t3tools/ai-os-contracts";
import * as Schema from "effect/Schema";

/**
 * Browser-safe board contract. The node client and the T3 server live on other
 * entry points so this module never pulls a socket or an HTTP listener.
 */
export const ADAPTER_BOARD_PATH = "/api/ai-os/board";
export const ADAPTER_BOARD_EVENTS_PATH = "/api/ai-os/board/events";
export const ADAPTER_BOARD_MOVE_PATH = "/api/ai-os/board/move";
export const ADAPTER_BOARD_EVENT_PATH = "/api/ai-os/board/event";

export interface AdapterBoardCard {
  readonly taskId: string;
  readonly title: string;
  readonly state: SequenceState;
  readonly threadId: string | null;
  readonly updatedAt: string;
}

// State stays unknown here on purpose. Decoding the sequence schema would pull
// the contracts package into the operations route.
const BoardCards = Schema.Array(
  Schema.Struct({
    taskId: Schema.String,
    title: Schema.String,
    state: Schema.Unknown,
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
    return decodeBoard(text) as readonly AdapterBoardCard[];
  } catch {
    return null;
  }
};
