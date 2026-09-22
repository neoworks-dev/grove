// The rows a changes section shows, as a folder tree or a flat list. Folders
// that hold nothing but one other folder are joined into one row ("src/main"),
// the way GitLens and VS Code compact them, so a deep path costs one row rather
// than one per directory.

import type { DiffChangeType, DiffFile } from '../../../../../shared/types'

export type ChangesLayout = 'tree' | 'list'

/** Text colour for each kind of change, on the status letter at a row's end. */
export const STATUS_COLOUR: Record<DiffChangeType, string> = {
  added: 'text-green',
  modified: 'text-amber',
  deleted: 'text-red',
  renamed: 'text-blue',
  untracked: 'text-violet'
}

/** The setting that picks between the two layouts. */
export const LAYOUT_SETTING = 'git.changesLayout'

export interface FolderRow {
  kind: 'folder'
  /** Repository-relative path of the (last joined) folder. */
  path: string
  /** What the row reads: one folder name, or several joined by `/`. */
  name: string
  depth: number
  fileCount: number
}

export interface FileRow {
  kind: 'file'
  file: DiffFile
  depth: number
}

export type ChangeRow = FolderRow | FileRow

interface FolderNode {
  name: string
  path: string
  folders: Map<string, FolderNode>
  files: DiffFile[]
}

/** Lays files out as rows, skipping the insides of any folder path in `collapsed`. */
export function changeRows(
  files: DiffFile[],
  layout: ChangesLayout,
  collapsed: ReadonlySet<string>
): ChangeRow[] {
  if (layout === 'list') {
    return sortedByPath(files).map((file) => ({ kind: 'file', file, depth: 0 }))
  }
  const root = compact(buildTree(files))
  const rows: ChangeRow[] = []
  appendFolderContents(root, 0, collapsed, rows)
  return rows
}

/** The name part of a repository-relative path. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return path
  return path.slice(slash + 1)
}

/** The folder part of a repository-relative path, empty at the root. */
export function directoryName(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return ''
  return path.slice(0, slash)
}

/** Files ordered by their full path. */
function sortedByPath(files: DiffFile[]): DiffFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}

/** Nests files under a folder node per path segment. */
function buildTree(files: DiffFile[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: new Map(), files: [] }
  for (const file of files) {
    folderFor(root, directoryName(file.path)).files.push(file)
  }
  return root
}

/** The node for a folder path, creating the chain down to it. */
function folderFor(root: FolderNode, directory: string): FolderNode {
  if (directory === '') return root
  let node = root
  for (const segment of directory.split('/')) {
    let child = node.folders.get(segment)
    if (!child) {
      child = { name: segment, path: joinPath(node.path, segment), folders: new Map(), files: [] }
      node.folders.set(segment, child)
    }
    node = child
  }
  return node
}

/** Joins a parent folder path and a segment. */
function joinPath(parent: string, segment: string): string {
  if (parent === '') return segment
  return `${parent}/${segment}`
}

/** Folds every folder holding exactly one folder and no files into that child. */
function compact(node: FolderNode): FolderNode {
  const folders = new Map<string, FolderNode>()
  for (const [key, child] of node.folders) {
    folders.set(key, compactChain(compact(child)))
  }
  return { ...node, folders }
}

/** Joins a lone-child chain into its first node, keeping the deepest path. */
function compactChain(node: FolderNode): FolderNode {
  if (node.files.length > 0 || node.folders.size !== 1) return node
  const [only] = node.folders.values()
  return { ...only, name: `${node.name}/${only.name}` }
}

/** Pushes a folder's subfolders, then its files, each level sorted by name. */
function appendFolderContents(
  node: FolderNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  rows: ChangeRow[]
): void {
  const folders = [...node.folders.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  for (const folder of folders) {
    rows.push({
      kind: 'folder',
      path: folder.path,
      name: folder.name,
      depth,
      fileCount: countFiles(folder)
    })
    if (!collapsed.has(folder.path)) appendFolderContents(folder, depth + 1, collapsed, rows)
  }
  const files = [...node.files].sort((left, right) =>
    baseName(left.path).localeCompare(baseName(right.path))
  )
  for (const file of files) rows.push({ kind: 'file', file, depth })
}

/** Every file under a folder, however deep. */
function countFiles(node: FolderNode): number {
  let total = node.files.length
  for (const child of node.folders.values()) total += countFiles(child)
  return total
}
