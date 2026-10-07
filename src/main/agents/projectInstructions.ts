// A project's instructions for agents — AGENTS.md and CLAUDE.md — as grove
// mode hands them over. Grove mode runs every harness in full isolation, so no
// harness reads them on its own; grove does it once, the same for all.
//
// A directory may hold either file or both. Both are often the same text —
// one a symlink or hard link to the other, or a CLAUDE.md that only imports
// `@AGENTS.md` — and are then read once. When they really differ, they are
// merged line by line: what they share once, and what only one says marked
// with the file it comes from, so neither is lost and nothing is paid twice.
//
// The worktree root's instructions go into the system prompt. A directory
// further down speaks up the first time the agent works inside it: its
// instructions ride along with that tool result, once per session.

import { readFile, realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { GroveTool } from './harness'
import { resolvePath } from './tools/workspaceFiles'

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

// More than any real instructions file; a runaway one is cut here.
const MAX_FILE_BYTES = 64 * 1024
// Above this many line pairs the merge stops looking for the best alignment
// and keeps the first file whole plus the lines only the second has.
const MAX_ALIGNMENT_CELLS = 4_000_000
// Two files are merged line by line only when at least this share of the
// shorter one's lines is also in the other; below it they are different
// documents, and each is served whole.
const MIN_SHARED_TO_MERGE = 0.5

export interface DirectoryInstructions {
  // The files the text came from, e.g. ['AGENTS.md', 'CLAUDE.md'].
  files: string[]
  text: string
}

interface InstructionFile {
  name: string
  // Resolved through symlinks, to tell a linked copy from a second file.
  realPath: string
  device: number
  inode: number
  text: string
}

/** A directory's instructions as one text, or null when it has none. */
export async function readDirectoryInstructions(
  dir: string
): Promise<DirectoryInstructions | null> {
  const found = (await Promise.all(INSTRUCTION_FILES.map((name) => readInstructionFile(dir, name))))
    .filter((file): file is InstructionFile => file !== null)
  if (found.length === 0) return null
  const files = found.map((file) => file.name)
  if (found.length === 1) return nonEmpty(files, found[0].text)

  const [first, second] = found
  if (sameFile(first, second)) return nonEmpty(files, first.text)
  // A file that imports the other stands for the other's text in its place.
  const firstText = expandImport(first.text, second)
  const secondText = expandImport(second.text, first)
  return nonEmpty(files, mergeInstructions(first.name, firstText, second.name, secondText))
}

/**
 * Two files' instructions as one text. When they are versions of the same
 * text: lines both have once, in order, and each stretch only one has marked
 * with its file. When they are mostly different documents, interleaving them
 * would only chop both up and cost markers, so each comes whole, marked.
 */
export function mergeInstructions(
  firstName: string,
  firstText: string,
  secondName: string,
  secondText: string
): string {
  const first = toLines(firstText)
  const second = toLines(secondText)
  if (first.join('\n') === second.join('\n')) return first.join('\n')

  const hunks = alignLines(first, second)
  const shared = hunks
    .filter((hunk) => hunk.kind === 'same')
    .reduce((count, hunk) => count + countText(hunk.lines), 0)
  if (shared < Math.min(countText(first), countText(second)) * MIN_SHARED_TO_MERGE) {
    return [whole(firstName, first), whole(secondName, second)].join('\n\n')
  }

  const out: string[] = []
  const mark = (name: string, lines: string[]): void => {
    // A stretch of blank lines is spacing, not something one file says.
    if (lines.every((line) => line.trim() === '')) {
      if (lines.length > 0 && out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
      return
    }
    // Keep the spacing the stretch opened with, outside the markers.
    if (lines[0].trim() === '' && out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    out.push(`[only in ${name}]`, ...trimBlankEdges(lines), `[/only in ${name}]`)
  }
  for (const hunk of hunks) {
    if (hunk.kind === 'same') out.push(...hunk.lines)
    else {
      mark(firstName, hunk.first)
      mark(secondName, hunk.second)
    }
  }
  return out.join('\n').trim()
}

/** One file's text in full, marked with its name. */
function whole(name: string, lines: string[]): string {
  return [`[${name}]`, ...lines, `[/${name}]`].join('\n')
}

/** Lines that say something, blank ones not counted. */
function countText(lines: string[]): number {
  return lines.filter((line) => line.trim() !== '').length
}

/** The prompt section for a directory's instructions. */
export function instructionsSection(
  instructions: DirectoryInstructions,
  location: string | null
): string {
  const files = instructions.files.join(' and ')
  const where = location ? ` in ${location}` : ' at the worktree root'
  const marked =
    instructions.files.length > 1 && /^\[(only in )?[^\]/]+\]$/m.test(instructions.text)
      ? '; text marked with a file name comes from that file alone'
      : ''
  const attribute = location ? ` path="${location}"` : ''
  return [
    `<project_instructions${attribute}>`,
    `From ${files}${where}${marked}. Follow them${location ? ` for work under ${location}` : ''}.`,
    '',
    instructions.text,
    '</project_instructions>'
  ].join('\n')
}

/** The worktree root's instructions as a system prompt section, or ''. */
export async function rootInstructionsSection(workspaceRoot: string): Promise<string> {
  const instructions = await readDirectoryInstructions(workspaceRoot).catch(() => null)
  return instructions ? instructionsSection(instructions, null) : ''
}

/**
 * One session's view of the instructions further down its worktrees: each
 * directory's are handed over the first time the session works under it, and
 * never again. The session's own root is in its system prompt already.
 */
export class NestedInstructions {
  private readonly seen = new Set<string>()

  constructor(private readonly worktreeRoots: () => string[]) {}

  /** Sections for every directory from the root to `absolutePath` not yet handed over. */
  async forPath(sessionRoot: string, absolutePath: string): Promise<string> {
    const root = this.rootOf(sessionRoot, absolutePath)
    if (!root) return ''
    const target = await directoryOf(absolutePath)
    const sections: string[] = []
    for (const dir of directoriesBetween(root, target)) {
      if (this.seen.has(dir)) continue
      this.seen.add(dir)
      // The session's root is in its system prompt; another worktree's isn't.
      if (dir === resolve(sessionRoot)) continue
      const instructions = await readDirectoryInstructions(dir).catch(() => null)
      if (!instructions) continue
      const location = relative(resolve(sessionRoot), dir) || '.'
      sections.push(instructionsSection(instructions, location.startsWith('..') ? dir : location))
    }
    return sections.join('\n\n')
  }

  /** The worktree a path lies in, the session's own counted among them. */
  private rootOf(sessionRoot: string, absolutePath: string): string | null {
    let best: string | null = null
    for (const candidate of [sessionRoot, ...this.worktreeRoots()].map((root) => resolve(root))) {
      if (!isInside(candidate, absolutePath)) continue
      if (!best || candidate.length > best.length) best = candidate
    }
    return best
  }
}

// Tools whose `path` says where the agent is working.
const PATH_TOOLS = new Set(['read', 'edit', 'write', 'find', 'grep', 'lsp', 'rename'])

/**
 * The tools, with the instructions of each directory the agent first works in
 * added to that call's result. Errors pass through untouched.
 */
export function withNestedInstructions(
  tools: GroveTool[],
  nested: NestedInstructions
): GroveTool[] {
  return tools.map((tool) => {
    if (!PATH_TOOLS.has(tool.name)) return tool
    const execute = tool.execute.bind(tool)
    const wrapped: GroveTool = {
      ...tool,
      async execute(input, context) {
        const result = await execute(input, context)
        const path = typeof input.path === 'string' && input.path ? input.path : null
        if (result.isError || !path) return result
        const extra = await nested
          .forPath(context.workspaceRoot, resolvePath(context.workspaceRoot, path))
          .catch(() => '')
        return extra ? { ...result, content: `${result.content}\n\n${extra}` } : result
      }
    }
    return wrapped
  })
}

// ── Reading ─────────────────────────────────────────────────────

async function readInstructionFile(dir: string, name: string): Promise<InstructionFile | null> {
  const path = join(dir, name)
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    const bytes = await readFile(path)
    return {
      name,
      realPath: await realpath(path),
      device: info.dev,
      inode: info.ino,
      text: bytes.subarray(0, MAX_FILE_BYTES).toString('utf8')
    }
  } catch {
    return null
  }
}

/** A symlink to the other, or a hard link: the same file under two names. */
function sameFile(a: InstructionFile, b: InstructionFile): boolean {
  return a.realPath === b.realPath || (a.device === b.device && a.inode === b.inode)
}

/** Claude Code's `@AGENTS.md` import lines, replaced by the file they import. */
function expandImport(text: string, other: InstructionFile): string {
  const pattern = new RegExp(`^\\s*@(?:\\./)?${escapeRegExp(other.name)}\\s*$`, 'i')
  if (!text.split(/\r?\n/).some((line) => pattern.test(line))) return text
  return text
    .split(/\r?\n/)
    .map((line) => (pattern.test(line) ? other.text.trimEnd() : line))
    .join('\n')
}

function nonEmpty(files: string[], text: string): DirectoryInstructions | null {
  const trimmed = text.trim()
  return trimmed ? { files, text: trimmed } : null
}

// ── Aligning ────────────────────────────────────────────────────

type Hunk = { kind: 'same'; lines: string[] } | { kind: 'differ'; first: string[]; second: string[] }

/** The two line lists as stretches they share and stretches where they differ. */
function alignLines(first: string[], second: string[]): Hunk[] {
  const n = first.length
  const m = second.length
  if ((n + 1) * (m + 1) > MAX_ALIGNMENT_CELLS) return roughAlignment(first, second)

  // Longest common subsequence, filled from the end so the walk runs forward.
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        first[i] === second[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const hunks: Hunk[] = []
  const push = (kind: 'same' | 'first' | 'second', line: string): void => {
    const last = hunks[hunks.length - 1]
    if (kind === 'same') {
      if (last?.kind === 'same') last.lines.push(line)
      else hunks.push({ kind: 'same', lines: [line] })
      return
    }
    const hunk: Extract<Hunk, { kind: 'differ' }> =
      last?.kind === 'differ' ? last : { kind: 'differ', first: [], second: [] }
    if (hunk !== last) hunks.push(hunk)
    hunk[kind].push(line)
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && first[i] === second[j]) {
      push('same', first[i])
      i++
      j++
    } else if (j >= m || (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      push('first', first[i++])
    } else {
      push('second', second[j++])
    }
  }
  return hunks
}

/** For files too long to align: the first whole, then what only the second has. */
function roughAlignment(first: string[], second: string[]): Hunk[] {
  const known = new Set(first)
  const extra = second.filter((line) => !known.has(line))
  return [
    { kind: 'same', lines: first },
    { kind: 'differ', first: [], second: extra }
  ]
}

// ── Paths ───────────────────────────────────────────────────────

/** The directory a path names, or the one holding it (also for files not written yet). */
async function directoryOf(absolutePath: string): Promise<string> {
  const info = await stat(absolutePath).catch(() => null)
  return info?.isDirectory() ? resolve(absolutePath) : dirname(resolve(absolutePath))
}

/** `root` and every directory below it down to `target`, outermost first. */
function directoriesBetween(root: string, target: string): string[] {
  if (!isInside(root, target)) return []
  const dirs = [root]
  const inside = relative(root, target)
  if (!inside) return dirs
  let current = root
  for (const part of inside.split(sep)) {
    current = join(current, part)
    dirs.push(current)
  }
  return dirs
}

function isInside(root: string, path: string): boolean {
  const inside = relative(root, resolve(path))
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

function toLines(text: string): string[] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
