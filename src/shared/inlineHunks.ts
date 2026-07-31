// Pure hunk assembly, shared by the main process and the renderer.
//
// The diffs themselves are always produced by git (see src/main/inlineDiff.ts);
// what lives here is the deterministic patch-assembly that turns a baseline plus
// a set of per-hunk verdicts back into file content. Both sides need it: main
// writes the result to disk, and the renderer needs the same line numbers to
// paint each hunk in the buffer the user is deciding in.

import type { AppliedRange, InlineHunk } from './types'

// Where one applied hunk ended up in the rebuilt content. `start` is the first
// line the hunk produced; for a pure deletion that is the line the removed text
// used to sit in front of, which is where its virtual lines belong.
export interface HunkMark {
  hunkIndex: number
  start: number
  added: number
  removed: string[]
}

export interface RebuildResult {
  content: string
  // Added-line ranges only, for painting; hunks that added nothing are absent.
  ranges: AppliedRange[]
  // Every applied hunk, including pure deletions.
  marks: HunkMark[]
}

/**
 * Rebuild file content from the baseline, applying each hunk whose `applied`
 * flag is set (accepted or still-pending) and reverting the rest to the
 * baseline's lines.
 */
export function rebuildWithAccepted(
  baseline: string,
  hunks: InlineHunk[],
  applied: boolean[]
): RebuildResult {
  const snap = baseline.split('\n')
  const out: string[] = []
  const ranges: AppliedRange[] = []
  const marks: HunkMark[] = []
  const ordered = hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((a, b) => a.hunk.beforeStart - b.hunk.beforeStart)
  let cursor = 1 // next 1-based baseline line to emit

  function record(index: number, hunk: InlineHunk, start: number): void {
    if (hunk.added.length > 0) {
      ranges.push({ hunkIndex: index, start, count: hunk.added.length })
    }
    marks.push({ hunkIndex: index, start, added: hunk.added.length, removed: hunk.removed })
  }

  for (const { hunk, index } of ordered) {
    const keep = applied[index]
    if (hunk.removed.length > 0) {
      for (let line = cursor; line < hunk.beforeStart; line++) out.push(snap[line - 1] ?? '')
      const startOut = out.length + 1
      if (keep) {
        for (const added of hunk.added) out.push(added)
        record(index, hunk, startOut)
      } else {
        for (let line = hunk.beforeStart; line < hunk.beforeStart + hunk.removed.length; line++) {
          out.push(snap[line - 1] ?? '')
        }
      }
      cursor = hunk.beforeStart + hunk.removed.length
      continue
    }
    // Pure insertion: added lines go after baseline line `beforeStart`.
    for (let line = cursor; line <= hunk.beforeStart; line++) out.push(snap[line - 1] ?? '')
    cursor = hunk.beforeStart + 1
    if (keep) {
      record(index, hunk, out.length + 1)
      for (const added of hunk.added) out.push(added)
    }
  }
  for (let line = cursor; line <= snap.length; line++) out.push(snap[line - 1] ?? '')
  return { content: out.join('\n'), ranges, marks }
}
