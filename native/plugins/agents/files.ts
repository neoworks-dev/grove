// The files panel's data: the files the agent and its guests changed this session (from the diffs
// of their tool calls), tagged by who and marked with what git says about each.
// Plain functions, so they are tested without a window. Ported from neoworks-harness apps/gui
// (plugins/files/files.ts), with the changes read from Grove's sidecar instead of `git status`.

import type { SessionEventRecord } from "@suite/protocol/types";
import type { DiffChangeType, DiffFile } from "../../../src/shared/types";

/** What a file shows: git's change, or `clean` for one an agent touched that git sees no difference in. */
export type Mark = "modified" | "added" | "deleted" | "renamed" | "untracked" | "clean";

/** A file an agent changed this session. */
export interface Touched {
  /** As the tool's diff names it, usually absolute. */
  path: string;
  /** Who changed it: "agent" (the session's own), "claude"... */
  tags: readonly string[];
}

/** What the session's events have said about files so far. */
export interface Touches {
  /** Tool call id to the guest that made the call (absent: the session's own agent). */
  toolAgents: Readonly<Record<string, string | undefined>>;
  touched: readonly Touched[];
}

export const NO_TOUCHES: Touches = { toolAgents: {}, touched: [] };

/** The tag a file gets from the agent that changed it: the guest's name, else `agent`. */
const OWN_AGENT_TAG = "agent";

/** The files with `path` touched once more by `tag`. */
function touch(touched: readonly Touched[], path: string, tag: string): Touched[] {
  const at = touched.findIndex((entry) => entry.path === path);
  if (at < 0) {
    return [...touched, { path, tags: [tag] }];
  }
  return touched.map((entry, index) => {
    if (index !== at || entry.tags.includes(tag)) {
      return entry;
    }
    return { ...entry, tags: [...entry.tags, tag] };
  });
}

/**
 * The touches after one more event of the session: diffs in tool call updates name the files.
 * Returns the same object when the event touches nothing.
 */
export function applyTouch(state: Touches, record: SessionEventRecord): Touches {
  const { event } = record;
  if (event.type === "tool_call") {
    if (state.toolAgents[event.toolCallId] === event.agent) {
      return state;
    }
    return { ...state, toolAgents: { ...state.toolAgents, [event.toolCallId]: event.agent } };
  }
  if (event.type !== "tool_call_update" || event.content === undefined) {
    return state;
  }
  let touched = state.touched;
  let tag = state.toolAgents[event.toolCallId];
  if (tag === undefined) {
    tag = OWN_AGENT_TAG;
  }
  for (const content of event.content) {
    if (content.type === "diff" && content.path !== "") {
      touched = touch(touched, content.path, tag);
    }
  }
  if (touched === state.touched) {
    return state;
  }
  return { ...state, touched };
}

/** `path` relative to `directory` when it is inside it; otherwise as it is. */
export function relativize(directory: string, path: string): string {
  const base = directory.replace(/\/+$/, "");
  if (path === base) {
    return ".";
  }
  if (path.startsWith(`${base}/`)) {
    return path.slice(base.length + 1);
  }
  if (path.startsWith("./")) {
    return path.slice(2);
  }
  return path;
}

export interface FileEntry {
  /** Relative to the session's worktree when inside it. */
  rel: string;
  /** Where a renamed file came from. */
  orig?: string;
  mark: Mark;
  /** Who changed it in this session. */
  tags: readonly string[];
  /** What git says about it; absent for a file only an agent touched, which has no diff to show. */
  file?: DiffFile;
}

/** The mark of a change git reports. */
function markOf(file: DiffFile): Mark {
  return file.changeType;
}

/**
 * The files of a worktree's changes with the same path merged: a file with staged and unstaged
 * edits is one entry, the unstaged one, whose diff against HEAD covers both.
 */
function mergedChanges(files: readonly DiffFile[]): DiffFile[] {
  const merged = new Map<string, DiffFile>();
  for (const file of files) {
    const known = merged.get(file.path);
    if (known === undefined || (known.staged && !file.staged)) {
      merged.set(file.path, file);
    }
  }
  return [...merged.values()];
}

/** Everyone who touched the file at `rel`, without repeats. */
function tagsFor(rel: string, base: string, touched: readonly Touched[]): string[] {
  const tags: string[] = [];
  for (const entry of touched) {
    if (relativize(base, entry.path) !== rel) {
      continue;
    }
    for (const tag of entry.tags) {
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }
  return tags;
}

/**
 * The files the session's agents touched, each marked with what git says about it. A touched file
 * git sees no change in (committed since, or reverted) is `clean`. Files changed by hand or by
 * other sessions are not listed. `base` is the worktree's directory, which paths in the agents'
 * diffs are made relative to; `changes` is undefined outside a repository.
 */
export function fileEntries(base: string, changes: readonly DiffFile[] | undefined, touched: readonly Touched[]): FileEntry[] {
  const gitFiles = new Map<string, DiffFile>();
  if (changes !== undefined) {
    for (const file of mergedChanges(changes)) {
      gitFiles.set(file.path, file);
    }
  }
  const entries: FileEntry[] = [];
  for (const touch of touched) {
    const rel = relativize(base, touch.path);
    if (entries.some((listed) => listed.rel === rel)) {
      continue;
    }
    entries.push(entryOf(rel, tagsFor(rel, base, touched), gitFiles.get(rel)));
  }
  return entries;
}

/** The entry for a touched file: marked by git's change when it has one. */
function entryOf(rel: string, tags: string[], file: DiffFile | undefined): FileEntry {
  if (file === undefined) {
    return { rel, mark: "clean", tags };
  }
  const entry: FileEntry = { rel, mark: markOf(file), tags, file };
  if (file.oldPath !== undefined) {
    entry.orig = file.oldPath;
  }
  return entry;
}

/** The git change a mark stands for, or undefined for `clean`. */
export function changeOfMark(mark: Mark): DiffChangeType | undefined {
  if (mark === "clean") {
    return undefined;
  }
  return mark;
}

/** One letter for the margin: M, A, D, R, ? or a dot for a file git sees no change in. */
export function glyphOfMark(mark: Mark): string {
  switch (mark) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    case "clean":
      return "·";
  }
}
