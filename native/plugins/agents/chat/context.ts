// How the chat's components reach the session they draw: the chat provides it with Svelte's
// context, and anything below reads it, so the ported components need no service of their own.

import { getContext, setContext } from "svelte";
import type { ChatSession } from "../chatSession";

const CHAT_CONTEXT = Symbol("grove.agents.chat");

/** Makes a session reachable from every chat component below the caller. */
export function provideChat(session: ChatSession): void {
  setContext(CHAT_CONTEXT, session);
}

/** The session the chat around this component draws. */
export function useChat(): ChatSession {
  const session = getContext<ChatSession | undefined>(CHAT_CONTEXT);
  if (!session) {
    throw new Error("useChat() was called outside a chat");
  }
  return session;
}
