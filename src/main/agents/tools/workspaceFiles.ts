// Files as grove mode's tools see them: the editor's buffer when the user has
// the file open, the disk otherwise.
//
// An agent that reads the disk while the user has unsaved changes in the
// editor edits a file the user is no longer looking at, and whichever of them
// saves last loses the other's work. Reading and writing through the buffer
// keeps them on one text; the write is saved straight away so the shell, git
// and the review see it too.

import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import type { DocumentInfo, EditOutcome } from '../../editorDocs'

/** A text file split into lines, with what it takes to write it back the same way. */
export interface FileText {
  lines: string[]
  /** The line ending it uses. */
  eol: '\n' | '\r\n'
  /** Whether it ends in a line ending. */
  finalNewline: boolean
  /** Whether the file exists at all; a missing one reads as a single empty line. */
  exists: boolean
  /** Whether it came from an editor buffer holding changes the disk does not have. */
  unsaved: boolean
}

/** Reading and writing files for an agent. */
export interface WorkspaceFiles {
  read(absolutePath: string): Promise<FileText>
  /**
   * Write `lines` over what `read` returned. Fails when the file moved on in
   * between, so an edit is never made against text the agent did not see.
   */
  write(absolutePath: string, read: FileText, lines: string[]): Promise<void>
}

/** The editor's documents, as far as the tools need them. */
export interface EditorBuffers {
  peek(worktreeId: string, path: string): Promise<{ document: DocumentInfo; lines: string[] } | null>
  replaceLines(
    worktreeId: string,
    path: string,
    expectedVersion: number,
    lines: string[]
  ): Promise<EditOutcome>
  save(worktreeId: string, path: string, expectedVersion: number | undefined): Promise<EditOutcome>
}

/** A worktree, as far as finding the one a path is in needs it. */
export interface WorktreeLocation {
  id: string
  path: string
}

/** A file as read, remembering the buffer version it was read at. */
interface ReadFrom extends FileText {
  buffer?: { worktreeId: string; path: string; version: number }
}

/** Files through the editor's buffers where it has them, the disk otherwise. */
export class EditorWorkspaceFiles implements WorkspaceFiles {
  constructor(
    private buffers: EditorBuffers,
    private worktrees: () => WorktreeLocation[]
  ) {}

  async read(absolutePath: string): Promise<FileText> {
    const located = locate(this.worktrees(), absolutePath)
    if (located) {
      const buffer = await this.buffers.peek(located.worktree.id, located.path).catch(() => null)
      if (buffer) return bufferText(located.worktree.id, located.path, buffer)
    }
    return readFromDisk(absolutePath)
  }

  async write(absolutePath: string, read: FileText, lines: string[]): Promise<void> {
    const buffer = (read as ReadFrom).buffer
    if (!buffer) {
      await writeToDisk(absolutePath, read, lines)
      return
    }
    const replaced = await this.buffers.replaceLines(
      buffer.worktreeId,
      buffer.path,
      buffer.version,
      lines
    )
    if (replaced.status === 'stale') throw new FileChangedError(absolutePath)
    await this.buffers.save(buffer.worktreeId, buffer.path, replaced.version)
  }
}

/** Files on disk alone, for a session no editor is attached to. */
export class DiskWorkspaceFiles implements WorkspaceFiles {
  read(absolutePath: string): Promise<FileText> {
    return readFromDisk(absolutePath)
  }

  write(absolutePath: string, read: FileText, lines: string[]): Promise<void> {
    return writeToDisk(absolutePath, read, lines)
  }
}

/** The file changed between reading it and writing it. */
export class FileChangedError extends Error {
  constructor(absolutePath: string) {
    super(`${absolutePath} changed while the edit was being made. Read it again and redo the edit.`)
    this.name = 'FileChangedError'
  }
}

/** A path an agent gave, resolved against the directory its session runs in. */
export function resolvePath(workspaceRoot: string, path: string): string {
  if (isAbsolute(path)) return resolve(path)
  return resolve(workspaceRoot, path)
}

/** A path as an agent is shown it: relative to its workspace when inside it. */
export function displayPath(workspaceRoot: string, absolutePath: string): string {
  const inside = relative(workspaceRoot, absolutePath)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return absolutePath
  }
  return inside
}

/** Split text into lines, noting its line ending and whether it ends in one. */
export function splitText(text: string): Omit<FileText, 'exists' | 'unsaved'> {
  let eol: FileText['eol'] = '\n'
  if (text.includes('\r\n')) eol = '\r\n'
  const lines = text.split(/\r?\n/)
  const finalNewline = lines.length > 1 && lines[lines.length - 1] === ''
  if (finalNewline) lines.pop()
  return { lines, eol, finalNewline }
}

/** Lines joined back into text the way the file had them. */
export function joinText(lines: string[], layout: Pick<FileText, 'eol' | 'finalNewline'>): string {
  const text = lines.join(layout.eol)
  if (layout.finalNewline && lines.length > 0) return text + layout.eol
  return text
}

/** The worktree a path lies in, and the path within it. */
export function locate(
  worktrees: WorktreeLocation[],
  absolutePath: string
): { worktree: WorktreeLocation; path: string } | null {
  let best: WorktreeLocation | null = null
  for (const worktree of worktrees) {
    const inside = relative(worktree.path, absolutePath)
    if (inside.startsWith('..') || isAbsolute(inside)) continue
    if (!best || worktree.path.length > best.path.length) best = worktree
  }
  if (!best) return null
  return { worktree: best, path: relative(best.path, absolutePath) }
}

function bufferText(
  worktreeId: string,
  path: string,
  buffer: { document: DocumentInfo; lines: string[] }
): ReadFrom {
  return {
    lines: buffer.lines,
    eol: '\n',
    finalNewline: true,
    exists: true,
    unsaved: buffer.document.dirty,
    buffer: { worktreeId, path, version: buffer.document.version }
  }
}

async function readFromDisk(absolutePath: string): Promise<FileText> {
  const info = await stat(absolutePath).catch(() => null)
  if (!info) return { lines: [''], eol: '\n', finalNewline: true, exists: false, unsaved: false }
  if (info.isDirectory()) throw new Error(`${absolutePath} is a directory.`)
  const text = await readFile(absolutePath, 'utf8')
  return { ...splitText(text), exists: true, unsaved: false }
}

async function writeToDisk(absolutePath: string, read: FileText, lines: string[]): Promise<void> {
  if (!read.exists) await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, joinText(lines, read))
}
