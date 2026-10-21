import * as Effect from "effect/Effect";

import { GrokT3Error } from "./errors.ts";

export const WORKER_CAPABILITIES = [
  "start",
  "retrieve_assignments",
  "report_status",
  "cancel",
  "resume",
  "return_artifacts",
  "report_usage",
  "receive_context",
  "heartbeat",
  "idempotency",
] as const;

export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

/** A worker plug-in. The console calls a method only when the adapter declares it. */
export interface WorkerAdapter {
  readonly id: string;
  readonly capabilities: ReadonlySet<WorkerCapability>;
}

export const hasCapability = (adapter: WorkerAdapter, capability: WorkerCapability): boolean =>
  adapter.capabilities.has(capability);

export const requireCapability = (
  adapter: WorkerAdapter,
  capability: WorkerCapability,
): Effect.Effect<void, GrokT3Error> =>
  hasCapability(adapter, capability)
    ? Effect.void
    : Effect.fail(
        new GrokT3Error({
          reason: "unsupported",
          detail: `${adapter.id} does not implement ${capability}.`,
        }),
      );
