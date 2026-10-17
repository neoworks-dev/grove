// The tool calls of a session as its events tell them: what each call was (its kind and input),
// where it stands, and the file changes it made. The chat items the daemon resolves carry a title
// and a result but not these, which the compact rows, the folded turns and the changed files need.
// Plain functions, so they are tested without a window.

import type { SessionEventRecord, ToolCallContent, ToolCallStatus, ToolKind } from "@suite/protocol/types";

/** One change to one file, as the tool reported it. */
export interface CallDiff {
  path: string;
  /** Absent when the call created the file. */
  oldText?: string;
  newText: string;
}

/** A tool call, as far as the events have told. */
export interface CallFacts {
  id: string;
  /** The ref of the chat item that draws the call. */
  ref: string;
  kind: ToolKind;
  /** The tool's name, once the harness says it. */
  tool?: string;
  title: string;
  status: ToolCallStatus;
  rawInput?: unknown;
  /** The guest that made the call; absent for the session's own agent. */
  agent?: string;
  diffs: readonly CallDiff[];
}

/** The calls of a session by the ref of their chat item. */
export interface Calls {
  readonly byRef: ReadonlyMap<string, CallFacts>;
}

/** No calls yet. Every fold starts from its own, since applying events writes into the map. */
export function noCalls(): Calls {
  return { byRef: new Map() };
}

/** The ref the daemon gives the chat item of a tool call. */
export function callRef(toolCallId: string): string {
  return `c-${toolCallId}`;
}

/**
 * The calls after one more event: a call starts with `tool_call`, and each update replaces the
 * fields it carries. The map is shared between the results, so a long session costs one write per
 * event; the returned object is new only when the event changed a call.
 */
export function applyCall(state: Calls, record: SessionEventRecord): Calls {
  const { event } = record;
  const byRef = state.byRef as Map<string, CallFacts>;
  if (event.type === "tool_call") {
    const call: CallFacts = {
      id: event.toolCallId,
      ref: callRef(event.toolCallId),
      kind: event.kind,
      title: event.title,
      status: event.status,
      diffs: [],
    };
    if (event.tool !== undefined) {
      call.tool = event.tool;
    }
    if (event.rawInput !== undefined) {
      call.rawInput = event.rawInput;
    }
    if (event.agent !== undefined) {
      call.agent = event.agent;
    }
    byRef.set(call.ref, call);
    return { byRef };
  }
  if (event.type !== "tool_call_update") {
    return state;
  }
  const known = byRef.get(callRef(event.toolCallId));
  if (known === undefined) {
    return state;
  }
  const call: CallFacts = { ...known };
  if (event.title !== undefined) {
    call.title = event.title;
  }
  if (event.tool !== undefined) {
    call.tool = event.tool;
  }
  if (event.rawInput !== undefined) {
    call.rawInput = event.rawInput;
  }
  if (event.status !== undefined) {
    call.status = event.status;
  }
  if (event.content !== undefined) {
    call.diffs = diffsOf(event.content);
  }
  byRef.set(call.ref, call);
  return { byRef };
}

/** The file changes among a call's content. */
function diffsOf(content: readonly ToolCallContent[]): CallDiff[] {
  const diffs: CallDiff[] = [];
  for (const entry of content) {
    if (entry.type !== "diff") {
      continue;
    }
    if (entry.path === "") {
      continue;
    }
    const change: CallDiff = { path: entry.path, newText: entry.newText };
    if (entry.oldText !== undefined) {
      change.oldText = entry.oldText;
    }
    diffs.push(change);
  }
  return diffs;
}

/**
 * The two texts a file's changes add up to: the first change's old text and the last one's new
 * text, when every change begins with what the one before it ended with. Changes that do not
 * chain, as those of a tool that reports only the lines it replaced, give none.
 */
export function chainedTexts(changes: readonly CallDiff[]): { oldText: string; newText: string } | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index].oldText !== changes[index - 1].newText) {
      return undefined;
    }
  }
  const first = changes[0];
  const last = changes[changes.length - 1];
  return { oldText: first.oldText === undefined ? "" : first.oldText, newText: last.newText };
}
