// How the chat's components reach the session they draw: the chat provides it with Svelte's
// context, and anything below reads it, so the ported components need no service of their own.

import { getContext, setContext } from "svelte";
import type { ChatSession } from "../chatSession";

const CHAT_CONTEXT = Symbol("grove.agents.chat");

/** Makes a session reachable from every chat component below the caller. */
export function provideChat(session: ChatSession): void {
  setContext(CHAT_CONTEXT, session);
}

const COLUMN_CONTEXT = Symbol("grove.agents.chat.column");

/** How much room the chat has for what it draws. */
export interface ColumnSize {
  /** Pixels. */
  readonly width: number;
}

/** Tells every chat component below the caller how wide the chat is. */
export function provideColumn(column: ColumnSize): void {
  setContext(COLUMN_CONTEXT, column);
}

/** The width of the chat around this component, or a default outside a chat. */
export function useColumn(): ColumnSize {
  const column = getContext<ColumnSize | undefined>(COLUMN_CONTEXT);
  if (!column) {
    return { width: 640 };
  }
  return column;
}

/** The session the chat around this component draws. */
export function useChat(): ChatSession {
  const session = getContext<ChatSession | undefined>(CHAT_CONTEXT);
  if (!session) {
    throw new Error("useChat() was called outside a chat");
  }
  return session;
}
