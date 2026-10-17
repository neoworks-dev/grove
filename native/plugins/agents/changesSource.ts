// The files panel's source on the real app: Grove's sidecar, which runs git for a worktree.

import type { DiffLine } from "@suite/protocol/types";
import type { DiffFile, DiffSides } from "../../../src/shared/types";
import type { ChangesSource } from "./filesModel";
import { parseUnified } from "./unified";

/** The part of the sidecar service the source calls. */
export interface SidecarCaller {
  call<Result = unknown>(channel: string, ...args: unknown[]): Promise<Result>;
}

/** Changes and diffs read from the sidecar's git routes. */
export function sidecarChanges(sidecar: SidecarCaller): ChangesSource {
  return {
    changedFiles: (worktreeId) => sidecar.call<DiffFile[]>("git:changedFiles", worktreeId),
    async diffLines(worktreeId, file): Promise<DiffLine[]> {
      const sides = await sidecar.call<DiffSides>("git:diffSides", worktreeId, file);
      const unified = await sidecar.call<string>("git:diffText", worktreeId, sides.original, sides.modified);
      return parseUnified(unified).flatMap((part) => part.lines);
    },
  };
}
