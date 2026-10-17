// The tool calls of a session as its events tell them: what each call was (its kind and input),
// where it stands, and the file changes it made. The chat items the daemon resolves carry a title
// and a result but not these, which the compact rows, the folded turns and the changed files need.
// Plain functions, so they are tested without a window.

import type { SessionEventRecord, ToolCallStatus, ToolKind } from "@suite/protocol/types";

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
function diffsOf(content: readonly { type: string }[]): CallDiff[] {
  const diffs: CallDiff[] = [];
  for (const entry of content) {
    if (entry.type !== "diff") {
      continue;
    }
    const diff = entry as { path: string; oldText?: string; newText: string };
    if (diff.path === "") {
      continue;
    }
    const change: CallDiff = { path: diff.path, newText: diff.newText };
    if (diff.oldText !== undefined) {
      change.oldText = diff.oldText;
    }
    diffs.push(change);
  }
  return diffs;
}
