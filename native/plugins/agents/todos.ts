// The session's shared todo list, which the user (from any app) and every agent change. Each
// `todos` event carries the whole list after one change and the newest is current. Plain
// functions, so they are tested without a window. Ported from neo term (apps/term widgets/todos.rs).

import type { TodoItem } from "@suite/protocol/types";

/** What a change to the list asks the daemon's `neo.todos` action for. */
export type TodoChange =
  | { action: "add"; text: string }
  | { action: "done" | "undone" | "remove"; id: string };

/** The change that checks an item off, or opens it again when it is done. */
export function toggleChange(item: TodoItem): TodoChange {
  if (item.done) {
    return { action: "undone", id: item.id };
  }
  return { action: "done", id: item.id };
}

/** How many items are checked off, for the heading. */
export function doneCount(items: readonly TodoItem[]): number {
  return items.filter((item) => item.done).length;
}

/** The text of a `/todo` command: what follows the command, trimmed. */
export function todoText(command: string): string {
  return command.trim().replace(/^\/todo\b/, "").trim();
}
