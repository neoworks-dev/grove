// Which sessions belong to the open repository, and how the sessions view lists them: grouped by
// worktree, the shown worktree first. Plain functions, so tests need no window. The list's
// ordering and the delegation indent follow the suite's own apps (neoworks-harness apps/gui).

import type { SessionInfo } from "@suite/protocol/types";

/** The part of a worktree the grouping reads. */
export interface WorktreePlace {
  id: string;
  name: string;
  path: string;
  branch: string;
}

/** One session row: the session, and whether another session delegated to it. */
export interface SessionRowData {
  info: SessionInfo;
  /** Delegated to by another session in the same group. */
  child: boolean;
}

/** The sessions that work in one worktree. */
export interface SessionGroup {
  /** The worktree's id. */
  key: string;
  /** The worktree's branch. */
  name: string;
  path: string;
  /** This is the worktree the workspace shows. */
  selected: boolean;
  rows: SessionRowData[];
}

/** A path without trailing slashes. */
export function trimmedPath(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Whether `child` is `parent` or lies below it. */
export function isWithin(child: string, parent: string): boolean {
  const childPath = trimmedPath(child);
  const parentPath = trimmedPath(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

/**
 * The worktree a directory works in: the one with the longest path that contains it, since the
 * main worktree's path also contains every worktree under `.worktrees`. Null outside them all.
 */
export function worktreeOf(cwd: string, worktrees: readonly WorktreePlace[]): WorktreePlace | null {
  let best: WorktreePlace | null = null;
  for (const worktree of worktrees) {
    if (!isWithin(cwd, worktree.path)) {
      continue;
    }
    if (best === null || trimmedPath(worktree.path).length > trimmedPath(best.path).length) {
      best = worktree;
    }
  }
  return best;
}

/** Orders sessions by last activity, newest first, with the id as the tiebreak. */
function newestFirst(first: SessionInfo, second: SessionInfo): number {
  if (first.lastActivity !== second.lastActivity) {
    return second.lastActivity - first.lastActivity;
  }
  return first.id < second.id ? -1 : 1;
}

/** A group's sessions in drawn order: each followed by the sessions it delegated to, the rest by recency. */
export function withChildren(sessions: readonly SessionInfo[]): SessionRowData[] {
  const ids = new Set(sessions.map((session) => session.id));
  const hasParentHere = (session: SessionInfo): boolean => session.parent !== undefined && ids.has(session.parent);
  const rows: SessionRowData[] = [];
  for (const info of sessions.filter((session) => !hasParentHere(session))) {
    rows.push({ info, child: info.parent !== undefined });
    for (const other of sessions) {
      if (other.parent === info.id) {
        rows.push({ info: other, child: true });
      }
    }
  }
  return rows;
}

/**
 * The sessions of the open repository grouped by worktree. A group is listed when it has a
 * session or is the shown worktree, the shown one first and the others by their latest activity.
 * Sessions that work outside the repository are left out.
 */
export function groupSessions(
  sessions: readonly SessionInfo[],
  worktrees: readonly WorktreePlace[],
  selectedWorktreeId: string | null,
): SessionGroup[] {
  const byWorktree = new Map<string, SessionInfo[]>();
  for (const session of [...sessions].sort(newestFirst)) {
    const worktree = worktreeOf(session.cwd, worktrees);
    if (worktree === null) {
      continue;
    }
    const list = byWorktree.get(worktree.id);
    if (list === undefined) {
      byWorktree.set(worktree.id, [session]);
    } else {
      list.push(session);
    }
  }
  const groups: SessionGroup[] = [];
  for (const worktree of worktrees) {
    const own = byWorktree.get(worktree.id);
    const selected = worktree.id === selectedWorktreeId;
    if (own === undefined && !selected) {
      continue;
    }
    groups.push({
      key: worktree.id,
      name: worktree.branch,
      path: worktree.path,
      selected,
      rows: withChildren(own === undefined ? [] : own),
    });
  }
  return groups.sort(compareGroups);
}

/** The latest activity in a group, or 0 for an empty one. */
function latestActivity(group: SessionGroup): number {
  let latest = 0;
  for (const row of group.rows) {
    latest = Math.max(latest, row.info.lastActivity);
  }
  return latest;
}

/** The shown worktree first, then the groups with the newest activity. */
function compareGroups(first: SessionGroup, second: SessionGroup): number {
  if (first.selected !== second.selected) {
    if (first.selected) {
      return -1;
    }
    return 1;
  }
  return latestActivity(second) - latestActivity(first);
}

/** The sessions that work in the same worktree as this one, in the order the sessions view lists them; this one alone when it is in none. */
export function siblingsOf(groups: readonly SessionGroup[], sessionId: string): SessionInfo[] {
  for (const group of groups) {
    if (group.rows.some((row) => row.info.id === sessionId)) {
      return group.rows.map((row) => row.info);
    }
  }
  return [];
}

/** What a session is called until it has a title of its own. */
export const UNTITLED_SESSION = "New chat";

/** The session's title on one line, else "New chat". */
export function sessionTitle(info: SessionInfo): string {
  const title = info.title?.trim();
  if (title) {
    return title.split(/\s+/).join(" ");
  }
  return UNTITLED_SESSION;
}

/** The latest thing said, on one line. */
export function previewOf(info: SessionInfo): string {
  if (info.preview === undefined) {
    return "";
  }
  return info.preview.split(/\s+/).filter(Boolean).join(" ");
}

/** How long ago, short: now, 5m, 3h, 2d. */
export function age(thenMs: number, nowMs: number): string {
  const seconds = Math.floor(Math.max(0, nowMs - thenMs) / 1000);
  if (seconds < 60) {
    return "now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86_400)}d`;
}
