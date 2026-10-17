// What the diff plugin asks of the native host (`src/diff.rs`). Kept apart from the service so the
// service runs under `bun test` with a fake.

import { invoke } from "@neoworks/svelte-gpui";
import type { Hunk } from "./model";

/** Where the old text of a hunk action comes from. */
export type GitBase = "head" | "index";

/** A file as git has it at a base. A file the base does not have reads as empty text. */
export interface BaseText {
  exists: boolean;
  text: string;
}

export interface DiffHost {
  /**
   * Compares a document with an old text, draws the difference on it under `source`, and answers
   * the hunks. In `split` mode `oldId` is a document that gets the old side's drawing.
   */
  apply(options: { newId: number; oldId?: number; oldText: string; mode: "inline" | "split"; source: string }): Promise<Hunk[]>;
  /** The hunks of a document against an old text, without drawing. */
  hunks(id: number, oldText: string): Promise<Hunk[]>;
  /** Shows the old lines of the hunk at a row above it, and answers whether there is one. */
  preview(id: number, oldText: string, row: number, source: string): Promise<boolean>;
  /** Puts the hunk of a document at a row into the index. */
  stageHunk(id: number, row: number): Promise<void>;
  /** Takes the hunk at a row of the index out of it. */
  unstageHunk(path: string, row: number): Promise<void>;
  /** Puts the old lines of the hunk at a row back into the document. */
  revertHunk(id: number, base: GitBase, row: number): Promise<void>;
  /** A file as HEAD or the index has it. */
  baseText(path: string, base: GitBase): Promise<BaseText>;
  /** Puts files back as the index has them, and deletes the untracked ones. */
  discard(files: { path: string; untracked: boolean }[]): Promise<void>;
}

/** The native host's diff commands. */
export function gpuiDiffHost(): DiffHost {
  return {
    apply: async (options) => {
      const answer = await invoke<{ hunks: Hunk[] }>("diff_apply", options);
      return answer.hunks;
    },
    hunks: async (id, oldText) => {
      const answer = await invoke<{ hunks: Hunk[] }>("diff_hunks", { id, oldText });
      return answer.hunks;
    },
    preview: async (id, oldText, row, source) => {
      const answer = await invoke<{ found: boolean }>("diff_preview", { id, oldText, row, source });
      return answer.found;
    },
    stageHunk: async (id, row) => {
      await invoke("hunk_stage", { id, row });
    },
    unstageHunk: async (path, row) => {
      await invoke("hunk_unstage", { path, row });
    },
    revertHunk: async (id, base, row) => {
      await invoke("hunk_revert", { id, base, row });
    },
    baseText: (path, base) => invoke<BaseText>("git_base_text", { path, base }),
    discard: async (files) => {
      await invoke("git_discard", { paths: files });
    },
  };
}
