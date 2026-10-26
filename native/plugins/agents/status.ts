// What the composer and the agents list show about a session, folded from its events: whether a
// turn runs, the harness and its settings, the approvals mode. Plain functions, so they are
// tested without a window. Ported from neoworks-harness apps/gui (lib/status.ts).

import type { SessionEventRecord, Usage } from "@suite/protocol/types";

export type Approvals = "ask" | "review" | "edits" | "auto";

/** Shift-Tab goes through them in this order. */
export const APPROVALS: readonly Approvals[] = ["ask", "review", "edits", "auto"];

/** The approvals mode after `mode` in the order Shift-Tab cycles through. */
export function nextApprovals(mode: Approvals): Approvals {
  const next = APPROVALS[(APPROVALS.indexOf(mode) + 1) % APPROVALS.length];
  if (next === undefined) {
    return "ask";
  }
  return next;
}

/** Whether a setting's value names an approvals mode. */
function isApprovals(value: string): value is Approvals {
  return APPROVALS.some((mode) => mode === value);
}

/** One harness's model choices; absent means the harness's own default. */
export interface HarnessSettings {
  model?: string;
  effort?: string;
  mode?: string;
}

export interface SessionStatus {
  /** From a user message until its turn ends. */
  running: boolean;
  /** The harness the session runs on: pi, claude, codex... */
  harness: string;
  approvals: Approvals;
  /** Per harness, so switching back shows that harness's choices again. */
  settings: Record<string, HarnessSettings>;
  /** The session's own agent; guests and subagents report their own. */
  usage?: Usage;
}

/** The status of a session nothing has happened in. */
export function initialStatus(): SessionStatus {
  return { running: false, harness: "pi", approvals: "ask", settings: {} };
}

/** The status after one more event. Returns the same object when the event changes nothing. */
export function applyStatusEvent(status: SessionStatus, record: SessionEventRecord): SessionStatus {
  const { event } = record;
  switch (event.type) {
    case "user_message":
      return { ...status, running: true };
    case "turn_ended":
      return { ...status, running: false };
    case "usage":
      if (event.agent !== undefined) {
        return status;
      }
      return { ...status, usage: event };
    case "setting_changed":
      return applySetting(status, event.harness, event.option, event.value);
    default:
      return status;
  }
}

/** The status after a harness's option was set; options the status does not show change nothing. */
function applySetting(status: SessionStatus, harness: string, option: string, value: string): SessionStatus {
  // The daemon logs its own options under "daemon"; sessions from before neo's rename say "suite".
  if (harness === "daemon" || harness === "suite") {
    return applySuiteSetting(status, option, value);
  }
  if (option !== "model" && option !== "effort" && option !== "mode") {
    return status;
  }
  const current = status.settings[harness];
  const settings = { ...current, [option]: value };
  return { ...status, settings: { ...status.settings, [harness]: settings } };
}

/** The status after one of the suite's own options (the harness, the approvals mode) was set. */
function applySuiteSetting(status: SessionStatus, option: string, value: string): SessionStatus {
  if (option === "harness") {
    return { ...status, harness: value };
  }
  if (option === "approvals" && isApprovals(value)) {
    return { ...status, approvals: value };
  }
  return status;
}

/** The settings of the harness the session runs on now. */
export function currentSettings(status: SessionStatus): HarnessSettings {
  const settings = status.settings[status.harness];
  if (settings === undefined) {
    return {};
  }
  return settings;
}
