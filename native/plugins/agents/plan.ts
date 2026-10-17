// The agent's plan, as the lists its events leave: every `plan` event replaces that agent's list
// (no `agent` is the session's own; an empty one clears it). Ported from neoworks-harness
// apps/gui (plugins/plan/plan.ts).

import type { Plan, PlanEntryStatus } from "@suite/protocol/types";

export interface PlanItem {
  text: string;
  status: PlanEntryStatus;
}

export interface PlanList {
  /** Absent for the session's own agent. */
  agent?: string;
  items: readonly PlanItem[];
}

/** The lists after a `plan` event. Insertion order is kept. */
export function applyPlan(lists: readonly PlanList[], plan: Plan): readonly PlanList[] {
  const items = plan.entries.map((entry) => ({ text: entry.content, status: entry.status }));
  const at = lists.findIndex((list) => list.agent === plan.agent);
  if (items.length === 0) {
    if (at < 0) {
      return lists;
    }
    return lists.filter((_, index) => index !== at);
  }
  const next: PlanList = { items };
  if (plan.agent !== undefined) {
    next.agent = plan.agent;
  }
  if (at < 0) {
    return [...lists, next];
  }
  return lists.map((list, index) => {
    if (index === at) {
      return next;
    }
    return list;
  });
}

/** The session's own list first, then the guests' in the order they appeared. */
export function ownFirst(lists: readonly PlanList[]): PlanList[] {
  const own = lists.filter((list) => list.agent === undefined);
  const guests = lists.filter((list) => list.agent !== undefined);
  return [...own, ...guests];
}

export interface PlanProgress {
  done: number;
  total: number;
}

/** How many entries of all lists are completed. */
export function progress(lists: readonly PlanList[]): PlanProgress {
  const items = lists.flatMap((list) => list.items);
  return { done: items.filter((item) => item.status === "completed").length, total: items.length };
}

/** The mark of an entry: done, in progress or to do. */
export function glyphOf(status: PlanEntryStatus): string {
  if (status === "completed") {
    return "✓";
  }
  if (status === "in_progress") {
    return "◐";
  }
  return "○";
}
