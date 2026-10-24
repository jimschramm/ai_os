import { ADAPTER_MEMORY_RESOLVE_PATH } from "@t3tools/ai-os-adapter/board";

import { primaryFetchInit } from "../../environments/primary/primaryRequest";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

export type MemoryResolutionAction = "keep" | "accept" | "correct";

export interface MemoryResolutionResponse {
  readonly _tag: "Applied" | "Rejected";
  readonly detail?: string;
  readonly outcome?: string;
}

/** The drawer posts Jim's decision to the board server, which records a SubmissionV1. */
export const postMemoryResolve = async (input: {
  readonly conflictId: string;
  readonly action: MemoryResolutionAction;
  readonly body?: string;
}): Promise<MemoryResolutionResponse> => {
  let url: string;
  try {
    url = resolvePrimaryEnvironmentHttpUrl(ADAPTER_MEMORY_RESOLVE_PATH);
  } catch {
    return { _tag: "Rejected", detail: "The board server is not connected." };
  }
  const init = await primaryFetchInit();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({
      conflictId: input.conflictId,
      action: input.action,
      ...(input.body === undefined ? {} : { body: input.body }),
    }),
    headers,
    ...(init.credentials ? { credentials: init.credentials } : {}),
  });
  const text = await response.text();
  try {
    const body = JSON.parse(text) as {
      readonly _tag?: string;
      readonly detail?: string;
      readonly outcome?: string;
    };
    if (response.ok) {
      return {
        _tag: "Applied",
        ...(body.detail === undefined ? {} : { detail: body.detail }),
        ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
      };
    }
    return {
      _tag: "Rejected",
      detail:
        body.detail ??
        (text.length > 0 ? text : `The resolution was rejected (${response.status}).`),
    };
  } catch {
    return {
      _tag: "Rejected",
      detail: text.length > 0 ? text : `The resolution was rejected (${response.status}).`,
    };
  }
};
