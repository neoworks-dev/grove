// File tree + read/write for the editor, scoped to a worktree root.
// Paths are validated to stay inside the worktree (no traversal escapes).

import { readdir, readFile, writeFile, stat, mkdir, rename as fsRename, rm } from 'fs/promises'
import { join, relative, resolve, sep, dirname } from 'path'
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

// Recursively list every file (not directory) under the worktree, as paths
// relative to the root. Used for the agent prompt's "@" file-mention menu.
// Capped so huge trees don't flood the renderer.
export async function listAll(worktreeRoot: string, limit = 5000): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      if (results.length >= limit) return
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else {
        results.push(relative(worktreeRoot, abs))
      }
    }
  }

  await walk(worktreeRoot)
  return results.sort((a, b) => a.localeCompare(b))
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

// ── Mutations (context-menu / keyboard CRUD) ────────────────────
// All take worktree-relative paths and validate they stay inside the root.

function resolveInside(worktreeRoot: string, relPath: string): string {
  const abs = join(worktreeRoot, relPath)
  if (!isInside(worktreeRoot, abs)) {
    throw new Error('path outside worktree')
  }
  return abs
}

export async function createFile(worktreeRoot: string, relPath: string): Promise<string> {
  const abs = resolveInside(worktreeRoot, relPath)
  await mkdir(dirname(abs), { recursive: true })
  // 'wx' fails if the file already exists — never clobber.
  await writeFile(abs, '', { flag: 'wx' })
  return abs
}

export async function createDir(worktreeRoot: string, relPath: string): Promise<string> {
  const abs = resolveInside(worktreeRoot, relPath)
  await mkdir(abs, { recursive: true })
  return abs
}

export async function renamePath(
  worktreeRoot: string,
  fromRel: string,
  toRel: string
): Promise<string> {
  const from = resolveInside(worktreeRoot, fromRel)
  const to = resolveInside(worktreeRoot, toRel)
  await mkdir(dirname(to), { recursive: true })
  await fsRename(from, to)
  return to
}

export async function removePath(worktreeRoot: string, relPath: string): Promise<void> {
  const abs = resolveInside(worktreeRoot, relPath)
  if (resolve(abs) === resolve(worktreeRoot)) {
    throw new Error('refusing to remove the worktree root')
  }
  await rm(abs, { recursive: true, force: true })
}
