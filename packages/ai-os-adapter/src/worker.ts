import type { ContextPackageSnapshotV1, UsageMeasurementV1 } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";

import { GrokT3Error } from "./errors.ts";

/** Every capability an adapter may declare. Call one only when it is in `capabilities`. */
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

/**
 * Generic operations keyed by capability. An adapter's `operations` object has
 * a function for each capability it advertises, and no others.
 */
export interface WorkerOperations<Session, Result> {
  readonly start: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly retrieve_assignments: () => Effect.Effect<readonly Session[], GrokT3Error>;
  readonly report_status: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly cancel: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly resume: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly return_artifacts: (taskId: string) => Result | null;
  readonly report_usage: (
    taskId: string,
    measurement: UsageMeasurementV1,
  ) => Effect.Effect<Session, GrokT3Error>;
  readonly receive_context: (
    taskId: string,
  ) => Effect.Effect<ContextPackageSnapshotV1, GrokT3Error>;
  readonly heartbeat: (
    taskId: string,
    observedAt: string,
    leaseExpiresAt: string,
  ) => Effect.Effect<Session, GrokT3Error>;
  readonly idempotency: (
    taskId: string,
    fingerprint: string,
  ) => Effect.Effect<Session, GrokT3Error>;
}

/**
 * Operations every worker plug-in implements. A method that the adapter did not
 * declare fails with `unsupported`; the console checks `capabilities` first.
 */
export interface WorkerAdapter<Session = unknown, Result = unknown> {
  readonly id: string;
  readonly capabilities: ReadonlySet<WorkerCapability>;
  readonly operations: Partial<WorkerOperations<Session, Result>>;
  readonly launch: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly observe: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly cancel: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly recover: (taskId: string) => Effect.Effect<Session, GrokT3Error>;
  readonly result: (taskId: string) => Result | null;
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
