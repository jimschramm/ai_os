import { ADAPTER_BOARD_MOVE_PATH } from "@t3tools/ai-os-adapter/board";
import type { KanbanColumn } from "@t3tools/ai-os-contracts";

import { primaryFetchInit } from "../../environments/primary/primaryRequest";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

export interface BoardMoveResponse {
  readonly _tag: "Applied" | "Rejected" | "NeedsConfirmation";
  readonly detail?: string;
}

export const postBoardMove = async (
  taskId: string,
  column: KanbanColumn,
  idempotencyKey: string,
  confirmed: boolean,
  model?: string,
): Promise<BoardMoveResponse> => {
  let url: string;
  try {
    url = resolvePrimaryEnvironmentHttpUrl(ADAPTER_BOARD_MOVE_PATH);
  } catch {
    return { _tag: "Rejected", detail: "The board server is not connected." };
  }
  const init = await primaryFetchInit();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const chosen = model?.trim() ?? "";
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({
      taskId,
      column,
      idempotencyKey,
      confirmed,
      ...(chosen.length > 0 ? { model: chosen } : {}),
    }),
    headers,
    ...(init.credentials ? { credentials: init.credentials } : {}),
  });
  const text = await response.text();
  if (response.ok) return { _tag: "Applied" };
  try {
    const body = JSON.parse(text) as { readonly _tag?: string; readonly detail?: string };
    if (body._tag === "NeedsConfirmation" || body._tag === "Rejected") {
      return {
        _tag: body._tag,
        ...(body.detail === undefined ? {} : { detail: body.detail }),
      };
    }
  } catch {
    // The status line is the fallback.
  }
  return {
    _tag: "Rejected",
    detail: text.length > 0 ? text : `The move was rejected (${response.status}).`,
  };
};
