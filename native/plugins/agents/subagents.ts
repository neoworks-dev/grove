// The agents working for a session, folded from its events: `subagent_started` and
// `subagent_ended` mark a delegation, and events labelled with the agent's harness name say what
// it does. Plain functions on immutable rows. Ported from neoworks-harness apps/gui
// (plugins/agents/agents.ts).

import type { SessionEventRecord, SessionInfo, StopReason } from "@suite/protocol/types";

/** How long a finished agent stays in the list. */
export const LINGER_MS = 5000;
/** Rows shown before the rest is folded into "+N more". */
export const MAX_ROWS = 6;

export type AgentState = "running" | "done" | "failed" | "stopped";

export interface AgentRow {
  id: string;
  /** Harness name: pi, claude, codex... */
  harness: string;
  model?: string;
  task: string;
  /** The directory it works in, when that is not the session's. */
  cwd?: string;
  /** The session it runs as, when it works in a directory of its own. */
  child?: string;
  state: AgentState;
  startedMs: number;
  endedMs?: number;
  /** Its latest tool call, or what it does between them. */
  activity: string;
  tokens?: number;
}

/** The tokens a usage report counts: input and output, else the context in use. */
function tokensOf(usage: { inputTokens?: number; outputTokens?: number; contextUsed?: number }): number | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return usage.contextUsed;
  }
  let total = 0;
  if (usage.inputTokens !== undefined) {
    total += usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    total += usage.outputTokens;
  }
  return total;
}

/** What a labelled event says about the running agent of that name, which must not be a session of its own. */
function note(rows: readonly AgentRow[], label: string | undefined, change: Partial<AgentRow>): readonly AgentRow[] {
  if (label === undefined) {
    return rows;
  }
  let at = -1;
  rows.forEach((row, index) => {
    if (row.harness === label && row.state === "running" && row.child === undefined) {
      at = index;
    }
  });
  const target = rows[at];
  if (target === undefined) {
    return rows;
  }
  return rows.map((row) => {
    if (row === target) {
      return { ...row, ...change };
    }
    return row;
  });
}

/** How a delegation ended, from the stop reason of its turn. */
function endState(stopReason: StopReason): AgentState {
  if (stopReason === "end_turn") {
    return "done";
  }
  if (stopReason === "cancelled") {
    return "stopped";
  }
  return "failed";
}

/** The row a `subagent_started` event begins. */
function startedRow(
  event: { id: string; agent: string; task: string; model?: string; cwd?: string; child?: string },
  startedMs: number,
): AgentRow {
  const row: AgentRow = {
    id: event.id,
    harness: event.agent,
    task: event.task,
    state: "running",
    startedMs,
    activity: "starting…",
  };
  if (event.model !== undefined) {
    row.model = event.model;
  }
  if (event.cwd !== undefined) {
    row.cwd = event.cwd;
  }
  if (event.child !== undefined) {
    row.child = event.child;
  }
  return row;
}

/** The rows after one more event of the session. Returns the same array when nothing changes. */
export function applyAgentEvent(rows: readonly AgentRow[], record: SessionEventRecord): readonly AgentRow[] {
  const { event } = record;
  switch (event.type) {
    case "subagent_started":
      if (rows.some((row) => row.id === event.id)) {
        return rows;
      }
      return [...rows, startedRow(event, record.ts)];
    case "subagent_ended":
      return endRow(rows, event, record.ts);
    // A delegation lives inside a turn: when the turn is over nothing still runs.
    case "turn_ended":
      return interruptRunning(rows, record.ts);
    case "tool_call":
      return note(rows, event.agent, { activity: event.title });
    case "agent_thought_chunk":
    case "agent_message_chunk":
      return note(rows, event.agent, { activity: "thinking…" });
    case "usage":
      return noteUsage(rows, event);
    default:
      return rows;
  }
}

/** The rows after a delegation ended. */
function endRow(
  rows: readonly AgentRow[],
  event: { id: string; stopReason: StopReason; error?: string },
  endedMs: number,
): readonly AgentRow[] {
  const state = endState(event.stopReason);
  let activity: string = state;
  if (state === "failed") {
    activity = "failed";
    if (event.error !== undefined) {
      activity = event.error;
    }
  }
  return rows.map((row) => {
    if (row.id === event.id) {
      return { ...row, state, endedMs, activity };
    }
    return row;
  });
}

/** The rows after a turn ended: delegations still running did not finish. */
function interruptRunning(rows: readonly AgentRow[], endedMs: number): readonly AgentRow[] {
  if (!rows.some((row) => row.state === "running")) {
    return rows;
  }
  return rows.map((row) => {
    if (row.state === "running") {
      return { ...row, state: "failed", endedMs, activity: "interrupted" };
    }
    return row;
  });
}

/** The rows after an agent reported its usage. */
function noteUsage(
  rows: readonly AgentRow[],
  usage: { agent?: string; inputTokens?: number; outputTokens?: number; contextUsed?: number },
): readonly AgentRow[] {
  const tokens = tokensOf(usage);
  if (tokens === undefined) {
    return rows;
  }
  return note(rows, usage.agent, { tokens });
}

/** Rows to draw: running ones and those that ended less than `LINGER_MS` ago. */
export function shownAgents(rows: readonly AgentRow[], nowMs: number): AgentRow[] {
  return rows.filter((row) => row.endedMs === undefined || nowMs - row.endedMs < LINGER_MS);
}

/**
 * What an agent that runs as a session of its own is doing, from that session: its latest
 * words, else what its row says.
 */
export function activityOf(row: AgentRow, sessions: readonly SessionInfo[]): string {
  if (row.child === undefined || row.state !== "running") {
    return row.activity;
  }
  const session = sessions.find((candidate) => candidate.id === row.child);
  if (session === undefined || session.preview === undefined) {
    return row.activity;
  }
  const line = session.preview.split(/\s+/).filter(Boolean).join(" ");
  if (line === "") {
    return row.activity;
  }
  return line;
}

/** `provider/model-id` reads as the id. */
export function modelLabel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/** `5s`, `1m 12s`, `2h 03m`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** `812`, `3.4k`, `1.2M`. */
export function compact(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The last path segment, for the directory a delegated agent works in. */
export function dirLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
