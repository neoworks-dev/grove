// File tree + read/write for the editor, scoped to a worktree root.
// Paths are validated to stay inside the worktree (no traversal escapes).

import {
  readdir,
  readFile,
  writeFile,
  stat,
  mkdir,
  rename as fsRename,
  rm,
  appendFile
} from 'fs/promises'
import { join, relative, resolve, sep, dirname, isAbsolute } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { FileNode } from '../shared/types'
import { ripgrep } from './ripgrep'

const execFileAsync = promisify(execFile)

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

/**
 * Every file under the worktree, as paths relative to the root, skipping what
 * .gitignore and the app's own ignore list exclude. Used for the agent
 * prompt's "@" file-mention menu and the file finder, both of which rank the
 * whole list — so it is complete by default and callers cap it themselves when
 * they want a shorter answer. Listed by ripgrep: a gitignored dataset or build
 * output can hold hundreds of thousands of files nobody wants to open.
 */
export async function listAll(
  worktreeRoot: string,
  limit = Number.POSITIVE_INFINITY
): Promise<string[]> {
  const excluded = [...IGNORED].flatMap((name) => ['--glob', `!${name}`])
  const output = await ripgrep(worktreeRoot, worktreeRoot, [
    '--files',
    '--hidden',
    '--no-require-git',
    ...excluded
  ])
  const paths = output.lines.filter((line) => line.length > 0)
  if (output.failed && paths.length === 0) {
    throw new Error(`listing files failed: ${output.error}`)
  }
  return paths
    .map((path) => relative(worktreeRoot, path))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
}

// List the entries of an arbitrary directory for the composer's @ path
// completion. Deliberately NOT worktree-scoped: `@../sibling/file` and
// `@~/notes.md` are valid agent mentions, so escapes are the point here.
export async function listPath(worktreeRoot: string, rawPath: string): Promise<FileNode[]> {
  let expanded = rawPath
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = join(homedir(), expanded.slice(1))
  }
  const dir = isAbsolute(expanded) ? expanded : resolve(worktreeRoot, expanded)
  const entries = await readdir(dir, { withFileTypes: true })
  const nodes: FileNode[] = []
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    nodes.push({
      name: entry.name,
      path: abs,
      relPath: relative(worktreeRoot, abs),
      isDir: entry.isDirectory()
    })
  }
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

// A viewer holds the whole file in memory, twice over while it is handed to
// a plugin page; past this it is better left unopened than opened slowly.
const MAX_BYTES_READ = 200 * 1024 * 1024

/** The raw bytes of a file inside the worktree, for viewers of binary formats. */
export async function readFileBytes(worktreeRoot: string, absPath: string): Promise<Uint8Array> {
  if (!isInside(worktreeRoot, absPath)) {
    throw new Error('path outside worktree')
  }
  const info = await stat(absPath)
  if (info.size > MAX_BYTES_READ) {
    throw new Error('file too large to open')
  }
  const data = await readFile(absPath)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
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

// ── Attachments (composer paste/drop) ────────────────────────────
// Saved under .workbench/attachments so the agent can read them via an
// @-mention; the dir is excluded from the app's own tree/search (IGNORED).

const ATTACHMENT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export async function saveAttachment(
  worktreeRoot: string,
  data: Uint8Array,
  ext: string
): Promise<{ relPath: string }> {
  if (data.byteLength === 0) throw new Error('empty attachment')
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('attachment too large (max 20 MB)')
  const safeExt = ATTACHMENT_EXTS.has(ext.toLowerCase()) ? ext.toLowerCase() : 'png'

  const dir = join(worktreeRoot, '.workbench', 'attachments')
  await mkdir(dir, { recursive: true })
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${safeExt}`
  await writeFile(join(dir, file), data)
  await excludeWorkbenchFromGit(worktreeRoot)
  return { relPath: join('.workbench', 'attachments', file) }
}

// Keep attachments (and everything else under .workbench) out of git status so
// they never pollute the diff panel. info/exclude in the common git dir covers
// every worktree without touching the repo's .gitignore. Best-effort.
async function excludeWorkbenchFromGit(worktreeRoot: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreeRoot }
    )
    const excludePath = join(stdout.trim(), 'info', 'exclude')
    const existing = await readFile(excludePath, 'utf8').catch(() => '')
    if (existing.split('\n').some((line) => line.trim() === '.workbench/')) return
    await mkdir(dirname(excludePath), { recursive: true })
    await appendFile(
      excludePath,
      `${existing.endsWith('\n') || existing === '' ? '' : '\n'}.workbench/\n`
    )
  } catch {
    // Not a git repo / git missing — attachments still work, they just show up
    // as untracked files.
  }
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

// A message can name any number of paths; checking more than this many at once
// is a message listing files, not pointing at them.
const MAX_EXISTENCE_CHECKS = 100

/**
 * The worktree-relative paths, of those given, that are files inside the
 * worktree. Anything that escapes the root, is a directory or is missing is
 * left out.
 */
export async function existingFiles(worktreeRoot: string, relPaths: string[]): Promise<string[]> {
  const candidates = relPaths.slice(0, MAX_EXISTENCE_CHECKS)
  const found = await Promise.all(candidates.map((relPath) => isFileInside(worktreeRoot, relPath)))
  return candidates.filter((_relPath, index) => found[index])
}

/** Whether the worktree-relative path names a file inside the worktree. */
async function isFileInside(worktreeRoot: string, relPath: string): Promise<boolean> {
  if (typeof relPath !== 'string' || relPath.length === 0 || isAbsolute(relPath)) {
    return false
  }
  const abs = join(worktreeRoot, relPath)
  if (!isInside(worktreeRoot, abs)) {
    return false
  }
  try {
    return (await stat(abs)).isFile()
  } catch {
    return false
  }
}
