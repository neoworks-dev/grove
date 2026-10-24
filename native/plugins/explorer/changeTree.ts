// Changed files as a folder tree: the shape the explorer shows, built from a flat list of paths.
// Used by the Git changes view and the agent's files panel. A folder takes the strongest change
// below it, and a chain of folders with nothing else in them is one row (`src/main/ipc`), as VS
// Code compacts them. No host and no Svelte, so it runs under `bun test`.

import type { DiffChangeType } from "../../../src/shared/types";
import { joinPath, strongerChange } from "./model";

/** One row of a tree of changes: a folder with its children, or a file. */
export interface ChangeTreeNode<Item> {
  /** Names the node within one tree; the same path in two sections gets two keys. */
  key: string;
  /** What the row shows. A compacted folder chain is `a/b/c`. */
  name: string;
  /** The path from the root; for a compacted chain, the innermost folder's. */
  relPath: string;
  isDir: boolean;
  /** A heading over a list of files, drawn by the consumer instead of as a folder. */
  section?: boolean;
  /** A file's own git change, or for a folder the strongest below it; absent for a file git sees no change in. */
  change?: DiffChangeType;
  /** What the file stands for in the consumer; absent on folders. */
  item?: Item;
  children: ChangeTreeNode<Item>[];
}

/** A file to put in the tree. */
export interface ChangedPath<Item> {
  path: string;
  change?: DiffChangeType;
  item: Item;
}

/** A folder or file on its way to being a node, while paths are still being added. */
interface Draft<Item> {
  name: string;
  relPath: string;
  isFile: boolean;
  change?: DiffChangeType;
  item?: Item;
  children: Map<string, Draft<Item>>;
}

/** An empty draft for a name under a path. */
function emptyDraft<Item>(name: string, relPath: string): Draft<Item> {
  return { name, relPath, isFile: false, children: new Map() };
}

/** The draft below `parent` with this name, made when there is none yet. */
function childDraft<Item>(parent: Draft<Item>, name: string): Draft<Item> {
  const known = parent.children.get(name);
  if (known !== undefined) {
    return known;
  }
  const made = emptyDraft<Item>(name, joinPath(parent.relPath, name));
  parent.children.set(name, made);
  return made;
}

/** Puts a file in the drafts, with a draft for each folder above it. */
function insertFile<Item>(root: Draft<Item>, file: ChangedPath<Item>): void {
  const names = file.path.split("/").filter((name) => name !== "");
  let current = root;
  for (const name of names) {
    current = childDraft(current, name);
  }
  current.isFile = true;
  current.change = file.change;
  current.item = file.item;
}

/** Folders before files, then by name without regard to case. */
function byFoldersThenName<Item>(first: ChangeTreeNode<Item>, second: ChangeTreeNode<Item>): number {
  if (first.isDir !== second.isDir) {
    if (first.isDir) {
      return -1;
    }
    return 1;
  }
  return first.name.toLowerCase().localeCompare(second.name.toLowerCase());
}

/** The strongest change among some nodes, or undefined when none has one. */
function strongestOf<Item>(nodes: ChangeTreeNode<Item>[]): DiffChangeType | undefined {
  let strongest: DiffChangeType | undefined = undefined;
  for (const node of nodes) {
    strongest = strongerChange(strongest, node.change);
  }
  return strongest;
}

/** The node for a draft and everything below it. */
function finish<Item>(draft: Draft<Item>, keyPrefix: string): ChangeTreeNode<Item> {
  const key = `${keyPrefix}${draft.relPath}`;
  if (draft.isFile) {
    const file: ChangeTreeNode<Item> = { key, name: draft.name, relPath: draft.relPath, isDir: false, children: [], item: draft.item };
    if (draft.change !== undefined) {
      file.change = draft.change;
    }
    return file;
  }
  const children = [...draft.children.values()].map((child) => finish(child, keyPrefix)).sort(byFoldersThenName);
  if (children.length === 1 && children[0].isDir) {
    return { ...children[0], name: `${draft.name}/${children[0].name}` };
  }
  const folder: ChangeTreeNode<Item> = { key, name: draft.name, relPath: draft.relPath, isDir: true, children };
  const change = strongestOf(children);
  if (change !== undefined) {
    folder.change = change;
  }
  return folder;
}

/**
 * The tree of some changed files, top level first. `keyPrefix` is put before every key, so two
 * trees in one list (staged and unstaged) do not clash on a path they share.
 */
export function buildChangeTree<Item>(files: ChangedPath<Item>[], keyPrefix = ""): ChangeTreeNode<Item>[] {
  const root = emptyDraft<Item>("", "");
  for (const file of files) {
    insertFile(root, file);
  }
  return [...root.children.values()].map((child) => finish(child, keyPrefix)).sort(byFoldersThenName);
}

/** The keys of every folder in a tree, to open them all. */
export function folderKeysOf<Item>(nodes: ChangeTreeNode<Item>[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (!node.isDir) {
      continue;
    }
    keys.push(node.key);
    keys.push(...folderKeysOf(node.children));
  }
  return keys;
}

/** The last folder name of a row's name, which is what an icon is picked by. */
export function lastSegment(name: string): string {
  const slash = name.lastIndexOf("/");
  return name.slice(slash + 1);
}
