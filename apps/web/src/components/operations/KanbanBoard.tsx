import { ADAPTER_BOARD_MOVE_PATH } from "@t3tools/ai-os-adapter/board";
import type { KanbanColumn } from "@t3tools/ai-os-contracts";
import { useState } from "react";

import { primaryFetchInit } from "../../environments/primary/primaryRequest";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import type { OperationsTask } from "./fixtures";
import {
  BOARD_COLUMNS,
  assignedAgent,
  assignedModel,
  blockerReason,
  columnFor,
  progressLine,
  projectLabel,
} from "./model";

const COLUMN_ACCENT: Record<(typeof BOARD_COLUMNS)[number]["id"], string> = {
  Backlog: "border-l-border",
  Ready: "border-l-info",
  Running: "border-l-info",
  Review: "border-l-warning",
  Blocked: "border-l-warning",
  Done: "border-l-success",
};

interface MoveResponse {
  readonly _tag: "Applied" | "Rejected" | "NeedsConfirmation";
  readonly detail?: string;
}

interface PendingMove {
  readonly taskId: string;
  readonly column: KanbanColumn;
  readonly key: string;
  readonly detail: string;
}

let moveSequence = 0;
const moveKey = (): string => {
  moveSequence += 1;
  return `m${moveSequence.toString(36)}t${Math.floor(performance.now()).toString(36)}`;
};

const postMove = async (
  taskId: string,
  column: KanbanColumn,
  idempotencyKey: string,
  confirmed: boolean,
): Promise<MoveResponse> => {
  let url: string;
  try {
    url = resolvePrimaryEnvironmentHttpUrl(ADAPTER_BOARD_MOVE_PATH);
  } catch {
    return { _tag: "Rejected", detail: "The board server is not connected." };
  }
  const init = await primaryFetchInit();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ taskId, column, idempotencyKey, confirmed }),
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

export function KanbanBoard({
  tasks,
  liveIds,
  names,
  onOpen,
}: {
  tasks: readonly OperationsTask[];
  liveIds: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  onOpen: (taskId: string) => void;
}) {
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const requestMove = async (
    task: OperationsTask,
    column: KanbanColumn,
    key: string,
    confirmed: boolean,
  ) => {
    if (!liveIds.has(task.id)) {
      setAlert("Demo cards stay put. Live tasks move only through the workflow.");
      setPending(null);
      return;
    }
    const result = await postMove(task.id, column, key, confirmed);
    if (result._tag === "NeedsConfirmation") {
      setAlert(null);
      setPending({
        taskId: task.id,
        column,
        key,
        detail: result.detail ?? "Confirm this move.",
      });
      return;
    }
    setPending(null);
    setAlert(
      result._tag === "Rejected" ? (result.detail ?? "The workflow rejected that move.") : null,
    );
  };

  const dropOn = (column: KanbanColumn, taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (task === undefined || columnFor(task) === column) return;
    void requestMove(task, column, moveKey(), false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {alert === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        >
          {alert}
        </p>
      )}
      {pending === null ? null : (
        <div
          role="alertdialog"
          aria-labelledby="kanban-confirm-title"
          className="flex flex-col gap-3 rounded-lg border border-border bg-card px-3 py-3"
        >
          <p id="kanban-confirm-title" className="text-sm">
            {pending.detail}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              autoFocus
              onClick={() => {
                const task = tasks.find((item) => item.id === pending.taskId);
                if (task === undefined) {
                  setPending(null);
                  return;
                }
                void requestMove(task, pending.column, pending.key, true);
              }}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPending(null);
                setAlert(null);
              }}
            >
              Keep it here
            </Button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-1">
        {BOARD_COLUMNS.map((column) => {
          const columnTasks = tasks.filter((task) => columnFor(task) === column.id);
          return (
            <section
              key={column.id}
              aria-labelledby={`column-${column.id}`}
              className="flex w-64 shrink-0 flex-col gap-2 rounded-xl border border-border bg-card/40 p-2"
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const taskId = event.dataTransfer.getData("text/plain");
                setDragging(null);
                if (taskId.length > 0) dropOn(column.id, taskId);
              }}
            >
              <div className="flex items-center justify-between gap-2 px-1.5 pt-1">
                <h3 id={`column-${column.id}`} className="text-sm font-medium">
                  {column.label}
                </h3>
                <Badge size="sm" variant="outline">
                  {columnTasks.length}
                  <span className="sr-only"> cards</span>
                </Badge>
              </div>
              <ul className="flex min-h-16 flex-col gap-2">
                {columnTasks.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      names={names}
                      accent={COLUMN_ACCENT[column.id]}
                      dragging={dragging === task.id}
                      onOpen={() => onOpen(task.id)}
                      onDragStart={() => setDragging(task.id)}
                      onDragEnd={() => setDragging(null)}
                      onMove={(next) => {
                        if (next !== column.id) void requestMove(task, next, moveKey(), false);
                      }}
                    />
                  </li>
                ))}
              </ul>
              {columnTasks.length === 0 ? (
                <p className="px-1.5 py-3 text-xs text-muted-foreground">Nothing here</p>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  names,
  accent,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  task: OperationsTask;
  names: ReadonlyMap<string, string>;
  accent: string;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (column: KanbanColumn) => void;
}) {
  const column = columnFor(task);
  const blocker = blockerReason(task);
  const moveId = `move-${task.id}`;
  return (
    <article
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`rounded-lg border border-border border-l-2 bg-card px-2.5 py-2 shadow-xs ${accent} ${dragging ? "opacity-60" : ""}`}
    >
      <h4 className="text-sm font-medium">
        <button
          type="button"
          onClick={onOpen}
          className="w-full text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="line-clamp-2">{task.title}</span>
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            {projectLabel(task.projectId, names)}
          </span>
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            {assignedAgent(task)} · {assignedModel(task)}
          </span>
          <span className="mt-2 line-clamp-2 block text-sm font-normal">{progressLine(task)}</span>
          {blocker === null ? null : (
            <span className="mt-1 block text-xs font-normal text-warning">Blocked: {blocker}</span>
          )}
        </button>
      </h4>
      <label htmlFor={moveId} className="mt-2 block text-xs text-muted-foreground">
        Move
        <select
          id={moveId}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={column ?? ""}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (isColumn(next)) onMove(next);
          }}
        >
          {column === null ? <option value="">Off the board</option> : null}
          {BOARD_COLUMNS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}

const isColumn = (value: string): value is KanbanColumn =>
  BOARD_COLUMNS.some((column) => column.id === value);
