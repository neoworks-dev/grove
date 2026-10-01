// The files a session has edited, and what each looked like without its edits.
//
// Every edit a harness makes is on the log as ACP diff content on its tool call:
// a fragment it replaced, or the whole file before and after. The side a file is
// compared against is rebuilt from the file as it is now, by undoing the
// session's own edits newest first. Whatever else changed the file — the user
// typing beside the agent, a formatter — is on both sides then, so the diff
// shows only what this session did.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

/** Merges `ours` and `theirs` over their common `base`, or null when they conflict. */
export type MergeText = (ours: string, base: string, theirs: string) => Promise<string | null>

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
 * An edit that can't be placed exactly, because the text it wrote has been
 * changed since, is undone by a three-way merge when that applies cleanly, and
 * left in otherwise.
 */
export async function textWithoutEdits(
  current: string,
  edits: readonly SessionEdit[],
  merge: MergeText
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
    const merged = await merge(text, edit.newText, edit.oldText)
    if (merged !== null) text = merged
  }
  return text
}

/** A three-way merge through `git merge-file`, or null when it conflicts or fails. */
export async function gitMergeText(ours: string, base: string, theirs: string): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-session-edits-'))
  try {
    const oursPath = join(directory, 'ours')
    const basePath = join(directory, 'base')
    const theirsPath = join(directory, 'theirs')
    await writeFile(oursPath, ours)
    await writeFile(basePath, base)
    await writeFile(theirsPath, theirs)
    return await runMergeFile(oursPath, basePath, theirsPath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Runs `git merge-file -p`; its exit code is the number of conflicts. */
function runMergeFile(oursPath: string, basePath: string, theirsPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['merge-file', '-p', '--quiet', oursPath, basePath, theirsPath],
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(stdout)
      }
    )
  })
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
