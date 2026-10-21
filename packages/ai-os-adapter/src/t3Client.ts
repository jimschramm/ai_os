import { ContextPackageSnapshotV1 } from "@t3tools/ai-os-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { GrokT3Error } from "./errors.ts";

/** Default origin of a local T3 server. Tests pass the fake server's origin instead. */
export const T3_LOCAL_ORIGIN = "http://127.0.0.1:3773";

export interface T3LaunchRequest {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly title: string;
  readonly prompt: string;
  readonly contextPackage: ContextPackageSnapshotV1;
}

export interface T3LaunchResult {
  readonly threadId: string;
  readonly created: boolean;
}

export interface T3ThreadView {
  readonly threadId: string;
  readonly status: "running" | "completed" | "interrupted";
  readonly text: string | null;
  readonly revision: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface T3LocalClient {
  readonly launch: (input: T3LaunchRequest) => Effect.Effect<T3LaunchResult, GrokT3Error>;
  readonly read: (threadId: string) => Effect.Effect<T3ThreadView, GrokT3Error>;
  readonly stop: (threadId: string) => Effect.Effect<void, GrokT3Error>;
}

const LaunchBody = Schema.Struct({
  idempotencyKey: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  contextPackage: ContextPackageSnapshotV1,
});

const LaunchResult = Schema.Struct({
  threadId: Schema.String,
  created: Schema.Boolean,
});

const ThreadView = Schema.Struct({
  threadId: Schema.String,
  status: Schema.Literals(["running", "completed", "interrupted"]),
  text: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
});

const StopResult = Schema.Struct({
  stopped: Schema.Boolean,
});

const unavailable = (method: string, url: string) =>
  new GrokT3Error({
    reason: "t3_unavailable",
    detail: `T3 did not answer ${method} ${url}.`,
  });

const rejected = (detail: string) => new GrokT3Error({ reason: "t3_rejected", detail });

const decodeJson = <A>(schema: Schema.Codec<A, string>, text: string) =>
  Schema.decodeEffect(schema)(text).pipe(
    Effect.mapError(() => rejected("T3 returned an unreadable payload.")),
  );

const exchange = (request: HttpClientRequest.HttpClientRequest, method: string, url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.acceptJson(request))
      .pipe(Effect.mapError(() => unavailable(method, url)));
    const text = yield* response.text.pipe(
      Effect.mapError(() => rejected("T3 returned an unreadable payload.")),
    );
    return { status: response.status, text };
  }).pipe(Effect.provide(FetchHttpClient.layer));

const refuse = (action: string, status: number) =>
  new GrokT3Error({
    reason: "t3_rejected",
    detail: `T3 refused the ${action} (${status}).`,
  });

/**
 * HTTP client for a local T3 server.
 *
 * Launch posts the prompt and the ContextPackage. The real server creates threads
 * with the `orchestration.launchThread` websocket method and reads them at
 * `GET /api/orchestration/threads/:threadId`. This client uses the same origin and
 * path shape so a fake server can stand in. It does not spawn Codex and it does
 * not call an update endpoint. Codex stays the pinned extension binary.
 */
export const httpT3LocalClient = (origin: string): T3LocalClient => {
  const root = origin.replace(/\/$/, "");
  const launch = (input: T3LaunchRequest) =>
    Effect.gen(function* () {
      const url = `${root}/api/orchestration/threads`;
      const request = yield* HttpClientRequest.schemaBodyJson(LaunchBody)(
        HttpClientRequest.post(url),
        input,
      ).pipe(Effect.mapError(() => rejected("Could not encode the T3 launch.")));
      const response = yield* exchange(request, "POST", url);
      if (response.status < 200 || response.status >= 300) {
        return yield* refuse("launch", response.status);
      }
      return yield* decodeJson(Schema.fromJsonString(LaunchResult), response.text);
    });
  const read = (threadId: string) =>
    Effect.gen(function* () {
      const url = `${root}/api/orchestration/threads/${encodeURIComponent(threadId)}`;
      const response = yield* exchange(HttpClientRequest.get(url), "GET", url);
      if (response.status < 200 || response.status >= 300) {
        return yield* refuse("thread read", response.status);
      }
      const view = yield* decodeJson(Schema.fromJsonString(ThreadView), response.text);
      return {
        threadId: view.threadId,
        status: view.status,
        text: view.text,
        revision: view.revision,
        ...(view.inputTokens === undefined ? {} : { inputTokens: view.inputTokens }),
        ...(view.outputTokens === undefined ? {} : { outputTokens: view.outputTokens }),
      } satisfies T3ThreadView;
    });
  const stop = (threadId: string) =>
    Effect.gen(function* () {
      const url = `${root}/api/orchestration/threads/${encodeURIComponent(threadId)}/stop`;
      const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), {}).pipe(
        Effect.mapError(() => rejected("Could not encode the T3 stop.")),
      );
      const response = yield* exchange(request, "POST", url);
      if (response.status < 200 || response.status >= 300) {
        return yield* refuse("stop", response.status);
      }
      const result = yield* decodeJson(Schema.fromJsonString(StopResult), response.text);
      if (!result.stopped) {
        return yield* rejected("T3 did not stop the thread.");
      }
    });
  return { launch, read, stop };
};
