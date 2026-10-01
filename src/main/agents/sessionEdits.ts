// The files a session has edited, and what each looked like without its edits.
//
// Every edit a harness makes is on the log as ACP diff content on its tool call:
// a fragment it replaced, or the whole file before and after. The side a file is
// compared against is rebuilt from the file as it is now, by undoing the
// session's own edits newest first. Whatever else changed the file — the user
// typing beside the agent, a formatter — is on both sides then, so the diff
// shows only what this session did.
//
// An edit is undone where it can be placed whole; failing that, line by line,
// each block it wrote that is still in the file going back to what it replaced.

import { isAbsolute, join, relative } from 'node:path'
import type { SessionEvent } from '../../shared/agents'
import { diffsOf, updateOf } from './acpLog'

/** One change a completed tool call made to one file. */
export interface SessionEdit {
  /** Absolute path, as the harness reported it. */
  path: string
  /** What the edit replaced: a fragment, the whole file, or null for a new file. */
  oldText: string | null
  newText: string
}

/** A zero-context line hunk: lines `removed` from `before` at `beforeStart`, `added` in their place. */
export interface LineHunk {
  /** 1-based; for a pure insertion, the line it follows (0 for the top). */
  beforeStart: number
  removed: string[]
  added: string[]
}

/** The zero-context hunks turning `before` into `after`. */
export type DiffLines = (before: string, after: string) => Promise<LineHunk[]>

interface CallEdits {
  status: string
  edits: SessionEdit[]
}

/**
 * Every edit the session's completed tool calls made, grouped by file in the
 * order each file was first edited. A call's diffs are taken from the last
 * update that carried any, since a result update replaces them with text and
 * a whole-file write only reports what it replaced once it has run.
 */
export function sessionEdits(events: readonly SessionEvent[]): Map<string, SessionEdit[]> {
  const calls = new Map<string, CallEdits>()
  for (const event of events) {
    noteToolUpdate(calls, event)
  }
  const byPath = new Map<string, SessionEdit[]>()
  for (const call of calls.values()) {
    if (call.status !== 'completed') continue
    for (const edit of call.edits) {
      addEdit(byPath, edit)
    }
  }
  return byPath
}

/** Folds one event into the calls seen so far, when it reports on a tool call. */
function noteToolUpdate(calls: Map<string, CallEdits>, event: SessionEvent): void {
  const update = updateOf(event)
  if (!update) return
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return

  let call = calls.get(update.toolCallId)
  if (!call) {
    call = { status: 'pending', edits: [] }
    calls.set(update.toolCallId, call)
  }
  if (update.status) call.status = update.status
  const diffs = diffsOf(update.content)
  if (diffs.length > 0) call.edits = diffs
}

/** Appends an edit to its file's list, starting the list on the file's first edit. */
function addEdit(byPath: Map<string, SessionEdit[]>, edit: SessionEdit): void {
  const existing = byPath.get(edit.path)
  if (existing) {
    existing.push(edit)
    return
  }
  byPath.set(edit.path, [edit])
}

/**
 * Undoes one edit in `text` when it can be placed exactly: the whole text is
 * what the edit wrote, or the fragment it wrote appears in it. Null otherwise —
 * including a deletion, whose empty replacement says nothing about where it was.
 */
export function revertEdit(text: string, edit: SessionEdit): string | null {
  if (edit.oldText === null) return ''
  if (text === edit.newText) return edit.oldText
  if (edit.newText.length === 0) return null
  const at = text.indexOf(edit.newText)
  if (at < 0) return null
  return text.slice(0, at) + edit.oldText + text.slice(at + edit.newText.length)
}

/**
 * The file as it would be without the session's edits, from what it is now.
 * An edit that can't be placed whole, because the text it wrote has been
 * changed since, is undone hunk by hunk: each block of lines it wrote that is
 * still there goes back to what it replaced, and the rest is left in.
 */
export async function textWithoutEdits(
  current: string,
  edits: readonly SessionEdit[],
  diffLines: DiffLines
): Promise<string> {
  let text = current
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]
    if (edit.oldText === null) return ''
    const reverted = revertEdit(text, edit)
    if (reverted !== null) {
      text = reverted
      continue
    }
    if (edit.newText.length === 0) continue
    const hunks = await diffLines(withFinalNewline(edit.newText), withFinalNewline(edit.oldText))
    text = revertHunks(text, splitLines(edit.newText), hunks)
  }
  return text
}

/**
 * Undoes the hunks of one edit in `text`, last first so the line numbers of the
 * ones before stay meaningful. `written` is what the edit wrote, as lines.
 */
export function revertHunks(text: string, written: readonly string[], hunks: readonly LineHunk[]): string {
  const lines = splitLines(text)
  // How far the file has drifted from what was written, to find each hunk near
  // where it was rather than at the first lookalike.
  const drift = lines.length - written.length
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    revertHunk(lines, written, hunks[index], drift)
  }
  return joinLines(lines, text.endsWith('\n'))
}

/** Undoes one hunk in place, when the lines around or of it can still be found. */
function revertHunk(lines: string[], written: readonly string[], hunk: LineHunk, drift: number): void {
  if (hunk.removed.length > 0) {
    const at = nearestRun(lines, hunk.removed, hunk.beforeStart - 1 + drift)
    if (at < 0) return
    lines.splice(at, hunk.removed.length, ...hunk.added)
    return
  }
  // The edit took these lines out; they go back after the line they followed.
  if (hunk.beforeStart === 0) {
    lines.splice(0, 0, ...hunk.added)
    return
  }
  const anchor = written[hunk.beforeStart - 1]
  const at = nearestRun(lines, [anchor], hunk.beforeStart - 1 + drift)
  if (at < 0) return
  lines.splice(at + 1, 0, ...hunk.added)
}

/** Where `run` appears in `lines` closest to `expected`, or -1 when nowhere. */
function nearestRun(lines: readonly string[], run: readonly string[], expected: number): number {
  let best = -1
  for (let start = 0; start + run.length <= lines.length; start += 1) {
    if (!runAt(lines, run, start)) continue
    if (best < 0 || Math.abs(start - expected) < Math.abs(best - expected)) best = start
  }
  return best
}

/** Whether `run` is in `lines` starting at `start`. */
function runAt(lines: readonly string[], run: readonly string[], start: number): boolean {
  for (let offset = 0; offset < run.length; offset += 1) {
    if (lines[start + offset] !== run[offset]) return false
  }
  return true
}

/** Text as lines, without the empty one a final newline would add. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** Lines back to text. */
function joinLines(lines: readonly string[], finalNewline: boolean): string {
  if (lines.length === 0) return ''
  const text = lines.join('\n')
  if (finalNewline) return `${text}\n`
  return text
}

/** Text ending in a newline, so a diff of two sides does not hinge on the last one. */
function withFinalNewline(text: string): string {
  if (text.length === 0 || text.endsWith('\n')) return text
  return `${text}\n`
}

/** A file path relative to the workspace, or null when it lies outside it. */
export function relativeInside(workspaceRoot: string, path: string): string | null {
  let absolute = path
  if (!isAbsolute(path)) absolute = join(workspaceRoot, path)
  const inside = relative(workspaceRoot, absolute)
  if (inside.length === 0) return null
  if (inside.startsWith('..') || isAbsolute(inside)) return null
  return inside
}
