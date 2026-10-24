import type {
  AttemptMemoryActivityV1,
  MemoryFactV1,
  SequenceState,
  StewardNoticeV1,
} from "@t3tools/ai-os-contracts";
import * as Schema from "effect/Schema";

/**
 * Browser-safe board contract. The node client and the T3 server live on other
 * entry points so this module never pulls a socket or an HTTP listener.
 */
export const ADAPTER_BOARD_PATH = "/api/ai-os/board";
export const ADAPTER_BOARD_EVENTS_PATH = "/api/ai-os/board/events";
export const ADAPTER_BOARD_MOVE_PATH = "/api/ai-os/board/move";
export const ADAPTER_BOARD_EVENT_PATH = "/api/ai-os/board/event";
export const ADAPTER_ANTIGRAVITY_MODELS_PATH = "/api/ai-os/antigravity/models";
export const ADAPTER_MEMORY_RESOLVE_PATH = "/api/ai-os/memory/resolve";
export const ADAPTER_MEMORY_WRITE_PATH = "/api/ai-os/memory/write";
export const ADAPTER_MEMORY_CONTEXT_PATH = "/api/ai-os/memory/context";
export const ADAPTER_MEMORY_WORKERS_PATH = "/api/ai-os/memory/workers";
export const ADAPTER_MEMORY_PROPOSE_PATH = "/api/ai-os/memory/propose";
export const ADAPTER_MEMORY_ACCEPT_PATH = "/api/ai-os/memory/accept";
export const ADAPTER_MEMORY_POLICY_PATH = "/api/ai-os/memory/policy";

export interface AdapterBoardCard {
  readonly taskId: string;
  readonly title: string;
  readonly state: SequenceState;
  readonly threadId: string | null;
  readonly runId?: string | null;
  readonly revision?: number;
  readonly updatedAt: string;
  /** Attempt reads and writes joined from memory. Absent on snapshots saved before that join. */
  readonly attempts?: readonly AttemptMemoryActivityV1[];
  /** Steward notices for this card's project. The Needs you list is the notification channel. */
  readonly steward?: readonly StewardNoticeV1[];
  /** Accepted and proposed facts for this card's project. The drawer reads these. */
  readonly memoryFacts?: readonly MemoryFactV1[];
}

// State stays unknown here on purpose. Decoding the sequence schema would pull
// the contracts package into the operations route.
const BoardCards = Schema.Array(
  Schema.Struct({
    taskId: Schema.String,
    title: Schema.String,
    state: Schema.Unknown,
    threadId: Schema.NullOr(Schema.String),
    runId: Schema.optional(Schema.NullOr(Schema.String)),
    revision: Schema.optional(Schema.Number),
    updatedAt: Schema.String,
    attempts: Schema.optional(Schema.Array(Schema.Unknown)),
    steward: Schema.optional(Schema.Array(Schema.Unknown)),
    memoryFacts: Schema.optional(Schema.Array(Schema.Unknown)),
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
