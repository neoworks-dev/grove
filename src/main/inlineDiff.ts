// Precise per-hunk diffing for inline agent edits. The agent writes the file in
// place (acceptEdits), so to review only *its* change we diff the pre-edit
// snapshot against the current file — not against HEAD, which would fold in any
// prior uncommitted work. The diff is produced by git (`git diff --no-index`),
// never in JS; only the hunk-body parse and the deterministic patch-assembly
// used to accept/reject individual hunks live here.

import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import type { AppliedRange, InlineHunk } from '../shared/types'
import { rebuildWithAccepted } from '../shared/inlineHunks'

// Re-exported so main-process callers keep one import for hunk work; the
// implementation is shared with the renderer, which paints the same ranges.
export { rebuildWithAccepted }

// Parse a zero-context (`-U0`) unified diff into hunks carrying their line
// bodies. File-header lines (`--- a/…`, `+++ b/…`) precede the first `@@`, so
// they are skipped while `current` is null; `\ No newline…` markers are ignored.
export function parseInlineHunks(diff: string): InlineHunk[] {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const hunks: InlineHunk[] = []
  let current: InlineHunk | null = null
  for (const line of diff.split('\n')) {
    const match = header.exec(line)
    if (match) {
      current = {
        beforeStart: Number(match[1]),
        removed: [],
        afterStart: Number(match[3]),
        added: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('-')) current.removed.push(line.slice(1))
    else if (line.startsWith('+')) current.added.push(line.slice(1))
  }
  return hunks
}

// `git diff --no-index` exits 1 when the files differ; that is expected, so the
// callback ignores the error and returns stdout (empty only when identical).
function gitDiffNoIndex(cwd: string, beforePath: string, afterPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['diff', '--no-index', '-U0', '--no-color', beforePath, afterPath],
      { cwd, maxBuffer: 20 * 1024 * 1024 },
      (_error, stdout) => resolve(stdout || '')
    )
  })
}

// Write both versions to a scratch directory and hand their paths to `run`, so
// two in-memory strings can be diffed by git rather than in JS.
async function withVersionPair<T>(
  before: string,
  after: string,
  run: (beforePath: string, afterPath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'grove-proposed-'))
  try {
    const beforePath = join(dir, 'before')
    const afterPath = join(dir, 'after')
    await writeFile(beforePath, before)
    await writeFile(afterPath, after)
    return await run(beforePath, afterPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Unified diff (with context) between two in-memory versions of a file, used to
// preview a pending Write/Edit before it is applied to disk. Produced by git so
// the diff isn't computed in JS.
export async function diffStrings(
  worktreePath: string,
  before: string,
  after: string
): Promise<string> {
  return withVersionPair(before, after, (beforePath, afterPath) =>
    gitDiffWithContext(worktreePath, beforePath, afterPath)
  )
}

// Zero-context hunks between two in-memory versions of a file. Unlike
// diffStrings this uses -U0, because rebuildWithAccepted reads each hunk's body
// as pure removed/added lines — context lines would be replayed as content.
export async function hunksBetween(
  worktreePath: string,
  before: string,
  after: string
): Promise<InlineHunk[]> {
  const diff = await withVersionPair(before, after, (beforePath, afterPath) =>
    gitDiffNoIndex(worktreePath, beforePath, afterPath)
  )
  return parseInlineHunks(diff)
}

function gitDiffWithContext(cwd: string, beforePath: string, afterPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['diff', '--no-index', '-U3', '--no-color', beforePath, afterPath],
      { cwd, maxBuffer: 20 * 1024 * 1024 },
      (_error, stdout) => resolve(stdout || '')
    )
  })
}

// Diff a pre-edit snapshot against the current on-disk file → the agent's hunks.
export async function diffSnapshot(
  worktreePath: string,
  relPath: string,
  snapshot: string
): Promise<InlineHunk[]> {
  const dir = await mkdtemp(join(tmpdir(), 'grove-inline-'))
  try {
    const beforePath = join(dir, 'before')
    await writeFile(beforePath, snapshot)
    const diff = await gitDiffNoIndex(worktreePath, beforePath, join(worktreePath, relPath))
    return parseInlineHunks(diff)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Write the file with only the applied hunks kept, returning the applied hunks'
// new line ranges for repainting.
export async function applyInlineReview(
  worktreePath: string,
  relPath: string,
  snapshot: string,
  hunks: InlineHunk[],
  applied: boolean[]
): Promise<AppliedRange[]> {
  const { content, ranges } = rebuildWithAccepted(snapshot, hunks, applied)
  await writeFile(join(worktreePath, relPath), content)
  return ranges
}
