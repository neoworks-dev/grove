// Where review comments are kept between runs: one file in Grove's data directory, holding the
// comments of every worktree by the worktree's path. File access is behind `ReviewFiles` so the
// store runs under `bun test`; the real one is in `hostFiles.ts`.

import type { ReviewComment } from "./model";

/** What the store needs from the file system. */
export interface ReviewFiles {
  /** Grove's data directory (see `src/data.rs`). */
  dataDirectory(): Promise<string>;
  /** The text of a file, or null when there is none. */
  readIfExists(path: string): Promise<string | null>;
  /** Writes a file, making the folders above it. */
  writeText(path: string, text: string): Promise<void>;
}

/** The comments of each worktree, by the worktree's path. */
export type WorktreeComments = Record<string, ReviewComment[]>;

/** The version of the file's layout. */
const FILE_VERSION = 1;

/** The file the comments are kept in. */
export function commentsPath(dataDirectory: string): string {
  return `${dataDirectory}/review/comments.json`;
}

/** Whether a value read from the file is a comment, down to the types of its fields. */
function isComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const numbers = [candidate.startRow, candidate.endRow, candidate.createdAt];
  const strings = [candidate.id, candidate.path, candidate.text];
  return (
    numbers.every((field) => typeof field === "number") &&
    strings.every((field) => typeof field === "string") &&
    typeof candidate.outdated === "boolean" &&
    Array.isArray(candidate.quoted) &&
    candidate.quoted.every((line) => typeof line === "string")
  );
}

/** The comments a file's text holds. A text that is not ours gives none, and a comment that is damaged is left out. */
export function parseComments(raw: string): WorktreeComments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const worktrees = (parsed as Record<string, unknown>).worktrees;
  if (typeof worktrees !== "object" || worktrees === null) {
    return {};
  }
  const comments: WorktreeComments = {};
  for (const [worktreePath, list] of Object.entries(worktrees)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const kept = list.filter(isComment);
    if (kept.length > 0) {
      comments[worktreePath] = kept;
    }
  }
  return comments;
}

/** The text of the file for these comments. */
export function writeComments(comments: WorktreeComments): string {
  return JSON.stringify({ version: FILE_VERSION, worktrees: comments }, null, 2);
}

export class CommentStore {
  constructor(private files: ReviewFiles) {}

  /** Reads every worktree's comments; none when nothing was saved yet. */
  async load(): Promise<WorktreeComments> {
    const directory = await this.files.dataDirectory();
    const raw = await this.files.readIfExists(commentsPath(directory));
    if (raw === null) {
      return {};
    }
    return parseComments(raw);
  }

  /** Writes every worktree's comments, replacing what was there. */
  async save(comments: WorktreeComments): Promise<void> {
    const directory = await this.files.dataDirectory();
    await this.files.writeText(commentsPath(directory), writeComments(comments));
  }
}
