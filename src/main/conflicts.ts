// The conflicted regions git leaves in a working-tree file, and applying a
// choice to one of them. `git.conflictedFiles` names the files; this describes
// what is actually wrong inside them, so a view can offer ours/theirs/both per
// conflict instead of handing the user a buffer full of markers.
//
// Parsing is deliberately line-based against the markers git writes rather than
// against the index: a half-resolved file is edited by hand as often as through
// a button, and the working tree is the only place that state exists.

import { readFile, writeFile } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import type { ConflictChoice, ConflictHunk, ConflictedFile, MergeState } from '../shared/types'
import { conflictedFiles, mergeInProgress } from './git'

// Markers are exactly seven characters, optionally followed by a space and a
// label. `|||||||` only appears under diff3/zdiff3 conflict style.
const OURS_MARKER = /^<{7}(?: (.*))?$/
const BASE_MARKER = /^\|{7}(?: (.*))?$/
const SPLIT_MARKER = /^={7}$/
const THEIRS_MARKER = /^>{7}(?: (.*))?$/

type Section = 'ours' | 'base' | 'theirs'

/** Strips the CR of a CRLF line ending, so markers match on a CRLF file too. */
function withoutCarriageReturn(line: string): string {
  if (line.endsWith('\r')) return line.slice(0, -1)
  return line
}

/**
 * The conflicts in a file's text, in the order they appear.
 *
 * A region that opens and never closes is not reported: a file may legitimately
 * contain a marker-like line, and treating one as a conflict would swallow
 * everything after it.
 */
export function parseConflictHunks(content: string): ConflictHunk[] {
  const lines = content.split('\n')
  const hunks: ConflictHunk[] = []
  let current: ConflictHunk | null = null
  let section: Section = 'ours'

  for (let index = 0; index < lines.length; index += 1) {
    const marker = withoutCarriageReturn(lines[index])

    if (current === null) {
      const opened = OURS_MARKER.exec(marker)
      if (!opened) continue
      current = {
        startLine: index + 1,
        endLine: 0,
        oursLabel: opened[1] || '',
        theirsLabel: '',
        ours: [],
        theirs: []
      }
      section = 'ours'
      continue
    }

    const closed = THEIRS_MARKER.exec(marker)
    if (closed) {
      current.endLine = index + 1
      current.theirsLabel = closed[1] || ''
      hunks.push(current)
      current = null
      continue
    }

    if (section === 'ours' && BASE_MARKER.test(marker)) {
      section = 'base'
      current.base = []
      continue
    }

    if (section !== 'theirs' && SPLIT_MARKER.test(marker)) {
      section = 'theirs'
      continue
    }

    // Line endings are the file's own, so the body keeps the line as it was.
    if (section === 'ours') current.ours.push(lines[index])
    else if (section === 'theirs') current.theirs.push(lines[index])
    else if (current.base) current.base.push(lines[index])
  }

  return hunks
}

/** The lines one conflict collapses to for a given choice. */
function linesForChoice(hunk: ConflictHunk, choice: ConflictChoice): string[] {
  if (choice === 'ours') return hunk.ours
  if (choice === 'theirs') return hunk.theirs
  return [...hunk.ours, ...hunk.theirs]
}

/**
 * Replaces one conflict with the side chosen, markers and all, leaving every
 * other conflict in the file exactly as it was.
 */
export function applyConflictChoice(
  content: string,
  hunkIndex: number,
  choice: ConflictChoice
): string {
  const hunks = parseConflictHunks(content)
  const hunk = hunks[hunkIndex]
  if (!hunk) {
    throw new Error(`conflict ${hunkIndex} is not in this file (it has ${hunks.length})`)
  }
  const lines = content.split('\n')
  lines.splice(
    hunk.startLine - 1,
    hunk.endLine - hunk.startLine + 1,
    ...linesForChoice(hunk, choice)
  )
  return lines.join('\n')
}

/** Resolves a worktree-relative path, refusing anything that escapes the root. */
function pathInside(worktreePath: string, relPath: string): string {
  const target = resolve(join(worktreePath, relPath))
  const rel = relative(worktreePath, target)
  if (rel.startsWith('..') || rel.startsWith(`${sep}`) || rel.length === 0) {
    throw new Error(`path outside worktree: ${relPath}`)
  }
  return target
}

/**
 * The conflicts in one file of a worktree.
 *
 * A conflict over a file's existence (added on one side, deleted on the other)
 * leaves nothing on disk to parse, so it reports none — the file is conflicted
 * without having a conflicted region.
 */
export async function conflictsInFile(
  worktreePath: string,
  relPath: string
): Promise<ConflictHunk[]> {
  try {
    const content = await readFile(pathInside(worktreePath, relPath), 'utf8')
    return parseConflictHunks(content)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Every conflicted file in a worktree, each with the conflicts inside it. */
export async function listConflicts(worktreePath: string): Promise<ConflictedFile[]> {
  const paths = await conflictedFiles(worktreePath)
  const files: ConflictedFile[] = []
  for (const path of paths) {
    files.push({ path, hunks: await conflictsInFile(worktreePath, path) })
  }
  return files
}

/** Where a worktree stands in a merge: whether one is open, and what is unresolved. */
export async function mergeState(worktreePath: string): Promise<MergeState> {
  return {
    inProgress: await mergeInProgress(worktreePath),
    files: await listConflicts(worktreePath)
  }
}

/**
 * Applies a choice to one conflict and writes the file back, reporting what is
 * still unresolved in it. An empty result means the file is ready to stage.
 */
export async function resolveConflictHunk(
  worktreePath: string,
  relPath: string,
  hunkIndex: number,
  choice: ConflictChoice
): Promise<ConflictHunk[]> {
  const target = pathInside(worktreePath, relPath)
  const content = await readFile(target, 'utf8')
  const resolved = applyConflictChoice(content, hunkIndex, choice)
  await writeFile(target, resolved, 'utf8')
  return parseConflictHunks(resolved)
}
