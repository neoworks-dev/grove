// A pull request's changed files as the tree the explorer draws, built with the same
// `buildChangeTree` as the git changes view and the agent's files panel.

import type { DiffChangeType } from "../../../src/shared/types";
import { buildChangeTree, type ChangeTreeNode } from "../explorer/changeTree";
import type { FileStatus, PullFile } from "./model";

/** The git change a pull request's file status is drawn as. */
export function changeOf(status: FileStatus): DiffChangeType {
  if (status === "removed") {
    return "deleted";
  }
  return status;
}

/** The files as a tree of folders, each file carrying its change and the file it stands for. */
export function pullFileTree(files: PullFile[]): ChangeTreeNode<PullFile>[] {
  return buildChangeTree(files.map((file) => ({ path: file.path, change: changeOf(file.status), item: file })));
}
