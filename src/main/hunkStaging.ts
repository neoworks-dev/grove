// Staging and unstaging a single hunk of a file. Git has no command for "stage
// hunk n", so the hunk is cut out of the file's own zero-context diff and fed
// back through `git apply --cached`. Zero context keeps the hunks exactly the
// ones `diffHunks` reports, so an index from the renderer names the same region
// here.

import { simpleGit } from 'simple-git'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DiffFile } from '../shared/types'

/**
 * Cuts one hunk out of a unified diff of a single file: the file header plus
 * that hunk's header and body. Null when the diff has no hunk at that index.
 */
export function hunkPatch(diff: string, hunkIndex: number): string | null {
  const lines = diff.split('\n')
  const hunkStarts: number[] = []
  lines.forEach((line, index) => {
    if (line.startsWith('@@')) hunkStarts.push(index)
  })
  if (hunkIndex < 0 || hunkIndex >= hunkStarts.length) return null

  const header = lines.slice(0, hunkStarts[0])
  const start = hunkStarts[hunkIndex]
  let end = lines.length
  if (hunkIndex + 1 < hunkStarts.length) end = hunkStarts[hunkIndex + 1]
  const body = trimTrailingEmpty(lines.slice(start, end))
  return `${[...header, ...body].join('\n')}\n`
}

/** Drops the empty strings a trailing newline leaves at the end of a split. */
function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end -= 1
  return lines.slice(0, end)
}

/** Moves one unstaged hunk of a file into the index. */
export async function stageHunk(
  worktreePath: string,
  file: DiffFile,
  hunkIndex: number
): Promise<void> {
  const diff = await fileDiff(worktreePath, file.path, false)
  await applyToIndex(worktreePath, requirePatch(diff, hunkIndex, file.path), false)
}

/** Takes one staged hunk of a file back out of the index, leaving the working tree alone. */
export async function unstageHunk(
  worktreePath: string,
  file: DiffFile,
  hunkIndex: number
): Promise<void> {
  const diff = await fileDiff(worktreePath, file.path, true)
  await applyToIndex(worktreePath, requirePatch(diff, hunkIndex, file.path), true)
}

/** The zero-context diff of one file, against the index or, when staged, against HEAD. */
async function fileDiff(worktreePath: string, relPath: string, staged: boolean): Promise<string> {
  const args = ['diff', '-U0', '--no-color', '--no-ext-diff']
  if (staged) args.push('--cached')
  args.push('--', relPath)
  return simpleGit({ baseDir: worktreePath }).raw(args)
}

/** The patch for one hunk, or an error naming the file when the hunk is gone. */
function requirePatch(diff: string, hunkIndex: number, relPath: string): string {
  const patch = hunkPatch(diff, hunkIndex)
  if (patch === null) {
    throw new Error(`${relPath} no longer has hunk ${hunkIndex + 1}; refresh and try again`)
  }
  return patch
}

/** Applies a patch to the index only, forwards or in reverse. */
async function applyToIndex(worktreePath: string, patch: string, reverse: boolean): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-hunk-'))
  try {
    const patchPath = join(directory, 'hunk.patch')
    await writeFile(patchPath, patch)
    const args = ['apply', '--cached', '--unidiff-zero']
    if (reverse) args.push('--reverse')
    args.push(patchPath)
    await simpleGit({ baseDir: worktreePath }).raw(args)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
