// A pull request's changed files as the directory tree they came from. The API
// hands back flat paths, which says nothing about where in the repository the
// change landed — two files with the same name are indistinguishable, and a
// change spread across one directory looks the same as one spread across five.

import type { GithubPrFile } from '../../../../../shared/types'

export interface PrFileTreeFile {
  kind: 'file'
  /** Full path from the repository root; unique, so it keys a rendered row. */
  path: string
  name: string
  file: GithubPrFile
}

export interface PrFileTreeDirectory {
  kind: 'directory'
  path: string
  /** Several segments when a chain of single-child directories was folded. */
  name: string
  children: PrFileTreeNode[]
}

export type PrFileTreeNode = PrFileTreeDirectory | PrFileTreeFile

/** A directory being assembled, before its children are sorted and folded. */
interface Building {
  directories: Map<string, Building>
  files: GithubPrFile[]
}

function emptyBuilding(): Building {
  return { directories: new Map(), files: [] }
}

/**
 * Group changed files into the tree of directories that holds them. Directories
 * come before files and both are sorted by name, matching the file explorer.
 *
 * A run of directories with nothing in it but the next directory is folded into
 * one row (`src/renderer/src`), so a deep path costs one line rather than four
 * — the same thing GitHub's own file tree does, and the reason a pull request
 * touching `src/main/routes/github.ts` stays readable.
 */
export function buildPrFileTree(files: GithubPrFile[]): PrFileTreeNode[] {
  const root = emptyBuilding()
  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) continue
    let current = root
    for (const segment of segments.slice(0, -1)) {
      let child = current.directories.get(segment)
      if (!child) {
        child = emptyBuilding()
        current.directories.set(segment, child)
      }
      current = child
    }
    current.files.push(file)
  }
  return childrenOf(root, '')
}

/** The sorted, folded children of one assembled directory. */
function childrenOf(building: Building, prefix: string): PrFileTreeNode[] {
  const directories: PrFileTreeDirectory[] = []
  for (const [name, child] of building.directories) {
    directories.push(foldDirectory(name, child, prefix))
  }
  directories.sort((a, b) => a.name.localeCompare(b.name))

  const files: PrFileTreeFile[] = building.files.map((file) => ({
    kind: 'file',
    path: file.path,
    name: file.path.split('/').pop() || file.path,
    file
  }))
  files.sort((a, b) => a.name.localeCompare(b.name))

  return [...directories, ...files]
}

/** One directory, with any single-child chain below it folded into its name. */
function foldDirectory(name: string, building: Building, prefix: string): PrFileTreeDirectory {
  let label = name
  let path = prefix ? `${prefix}/${name}` : name
  let current = building
  while (current.files.length === 0 && current.directories.size === 1) {
    const [childName, child] = [...current.directories][0]
    label = `${label}/${childName}`
    path = `${path}/${childName}`
    current = child
  }
  return { kind: 'directory', path, name: label, children: childrenOf(current, path) }
}

/** Every file in the tree, in the order the rows appear. */
export function flattenPrFileTree(nodes: PrFileTreeNode[]): PrFileTreeFile[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'file') return [node]
    return flattenPrFileTree(node.children)
  })
}

/**
 * The file to read after this one: the next one down the list that has not been
 * read, wrapping to the top so the last file leads back to whatever was skipped.
 * Null once nothing is left, which is how the caller knows the review is done.
 */
export function nextUnreadFile(
  nodes: PrFileTreeNode[],
  afterPath: string,
  isRead: (path: string) => boolean
): PrFileTreeFile | null {
  const files = flattenPrFileTree(nodes)
  const start = files.findIndex((file) => file.path === afterPath)
  for (let step = 1; step <= files.length; step += 1) {
    // From just past the current file, wrapping; `start` of -1 starts at the
    // top, which is what an unknown path should do.
    const candidate = files[(start + step) % files.length]
    if (candidate && !isRead(candidate.path)) return candidate
  }
  return null
}
