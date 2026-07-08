// File tree + read/write for the editor, scoped to a worktree root.
// Paths are validated to stay inside the worktree (no traversal escapes).

import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import type { FileNode } from '../shared/types'

const IGNORED = new Set(['.git', 'node_modules', '.workbench', '.worktrees', 'out', 'dist'])

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !rel.startsWith('..') && !resolve(target).includes(`${sep}..${sep}`)
}

// List immediate children of a directory (lazy tree expansion).
export async function listDir(worktreeRoot: string, relPath: string): Promise<FileNode[]> {
  const dir = relPath ? join(worktreeRoot, relPath) : worktreeRoot
  if (!isInside(worktreeRoot, dir)) {
    throw new Error('path outside worktree')
  }
  const entries = await readdir(dir, { withFileTypes: true })
  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    const abs = join(dir, entry.name)
    nodes.push({
      name: entry.name,
      path: abs,
      relPath: relative(worktreeRoot, abs),
      isDir: entry.isDirectory()
    })
  }
  // Directories first, then alphabetical.
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export async function readFileContent(worktreeRoot: string, absPath: string): Promise<string> {
  if (!isInside(worktreeRoot, absPath)) {
    throw new Error('path outside worktree')
  }
  const info = await stat(absPath)
  if (info.size > 5 * 1024 * 1024) {
    throw new Error('file too large to open')
  }
  return readFile(absPath, 'utf8')
}

export async function writeFileContent(
  worktreeRoot: string,
  absPath: string,
  content: string
): Promise<void> {
  if (!isInside(worktreeRoot, absPath)) {
    throw new Error('path outside worktree')
  }
  await writeFile(absPath, content, 'utf8')
}
