// The text of the line under the input, as segments with a meaning (the component maps the tone
// to a colour): the approvals mode that Shift-Tab changes, the harness and its model, and how
// full the context is. Plain functions, so they are tested without a window. Ported from
// neoworks-harness apps/gui (plugins/statusline/segments.ts).

import type { Usage } from "@suite/protocol/types";
import { currentSettings, type Approvals, type SessionStatus } from "./status";

export type Tone = "muted" | "accent" | "danger";

export interface Segment {
  text: string;
  tone: Tone;
}

/** ask is muted, review and edits are accent, auto is danger (nothing asks first). */
export function approvalsTone(mode: Approvals): Tone {
  if (mode === "auto") {
    return "danger";
  }
  if (mode === "ask") {
    return "muted";
  }
  return "accent";
}

/** How full the context window is, in whole percent; undefined when either number is unknown. */
export function contextPercent(usage: Usage | undefined): number | undefined {
  if (usage === undefined || usage.contextUsed === undefined || usage.contextSize === undefined || usage.contextSize <= 0) {
    return undefined;
  }
  return Math.round((usage.contextUsed / usage.contextSize) * 100);
}

/** `$0.04`, `$1.20`; a tenth of a cent shows as `<$0.01`. */
export function formatCost(cost: number | undefined): string | undefined {
  if (cost === undefined) {
    return undefined;
  }
  if (cost > 0 && cost < 0.01) {
    return "<$0.01";
  }
  return `$${cost.toFixed(2)}`;
}

/** The line's segments, left to right. */
export function statusSegments(status: SessionStatus): Segment[] {
  const settings = currentSettings(status);
  const segments: Segment[] = [];
  const add = (text: string | undefined, tone: Tone = "muted"): void => {
    if (text !== undefined && text !== "") {
      segments.push({ text, tone });
    }
  };
  add(status.approvals, approvalsTone(status.approvals));
  add(status.harness);
  add(settings.model);
  add(settings.effort);
  add(settings.mode);
  if (status.running) {
    add("working", "accent");
  }
  const percent = contextPercent(status.usage);
  if (percent !== undefined) {
    let tone: Tone = "muted";
    if (percent >= 90) {
      tone = "danger";
    }
    add(`${percent}% context`, tone);
  }
  add(formatCost(status.usage?.cost));
  return segments;
}
