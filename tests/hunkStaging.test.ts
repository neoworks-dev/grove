// Hunk staging is cut out of git's own zero-context diff and applied back to
// the index, so the cases worth covering are the shapes that patch can take:
// a change in the middle, a pure addition and a pure deletion, and the index
// ending up holding exactly one of two hunks.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'

import { hunkPatch, stageHunk, unstageHunk } from '../src/main/hunkStaging'
import { branchStatus } from '../src/main/git'
import type { DiffFile } from '../src/shared/types'

const ORIGINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', ''].join('\n')
const FILE: DiffFile = { path: 'numbers.txt', changeType: 'modified', staged: false }

/** A repository with numbers.txt committed at ORIGINAL. */
async function scratchRepo(): Promise<{ directory: string; git: SimpleGit }> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-hunks-'))
  const git = simpleGit({ baseDir: directory })
  await git.init()
  await git.addConfig('user.name', 'Grove Test')
  await git.addConfig('user.email', 'test@grove.invalid')
  await writeFile(join(directory, FILE.path), ORIGINAL)
  await git.add(FILE.path)
  await git.commit('numbers')
  return { directory, git }
}

/** The index's copy of numbers.txt. */
function indexed(git: SimpleGit): Promise<string> {
  return git.raw(['show', `:${FILE.path}`])
}

describe('hunkPatch', () => {
  const diff = [
    'diff --git a/f b/f',
    'index 1..2 100644',
    '--- a/f',
    '+++ b/f',
    '@@ -2 +2 @@',
    '-two',
    '+TWO',
    '@@ -7,0 +8 @@',
    '+new',
    ''
  ].join('\n')

  test('keeps the file header and only the chosen hunk', () => {
    expect(hunkPatch(diff, 1)).toBe(
      [
        'diff --git a/f b/f',
        'index 1..2 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -7,0 +8 @@',
        '+new',
        ''
      ].join('\n')
    )
  })

  test('an index past the last hunk has no patch', () => {
    expect(hunkPatch(diff, 2)).toBeNull()
    expect(hunkPatch('', 0)).toBeNull()
  })
})

describe('stageHunk / unstageHunk', () => {
  test('stages one of two hunks and leaves the other in the working tree', async () => {
    const { directory, git } = await scratchRepo()
    const edited = ORIGINAL.replace('two', 'TWO').replace('seven', 'SEVEN')
    await writeFile(join(directory, FILE.path), edited)

    await stageHunk(directory, FILE, 1)

    expect(await indexed(git)).toBe(ORIGINAL.replace('seven', 'SEVEN'))
    const unstaged = await git.raw(['diff', '--name-only'])
    expect(unstaged.trim()).toBe(FILE.path)
  })

  test('stages a pure addition and a pure deletion', async () => {
    const { directory, git } = await scratchRepo()
    const edited = ORIGINAL.replace('three\n', '').replace('six\n', 'six\nsix and a half\n')
    await writeFile(join(directory, FILE.path), edited)

    await stageHunk(directory, FILE, 0)
    await stageHunk(directory, FILE, 0)

    expect(await indexed(git)).toBe(edited)
  })

  test('unstaging a hunk takes it out of the index but not the working tree', async () => {
    const { directory, git } = await scratchRepo()
    const edited = ORIGINAL.replace('two', 'TWO').replace('seven', 'SEVEN')
    await writeFile(join(directory, FILE.path), edited)
    await git.add(FILE.path)

    await unstageHunk(directory, { ...FILE, staged: true }, 0)

    expect(await indexed(git)).toBe(ORIGINAL.replace('seven', 'SEVEN'))
    const working = await git.raw(['diff', '--', FILE.path])
    expect(working).toContain('+TWO')
  })

  test('a hunk that is gone is refused by name', async () => {
    const { directory } = await scratchRepo()
    await expect(stageHunk(directory, FILE, 0)).rejects.toThrow('numbers.txt no longer has hunk 1')
  })
})

describe('branchStatus', () => {
  test('a branch with no upstream is neither ahead nor behind', async () => {
    const { directory } = await scratchRepo()
    const status = await branchStatus(directory)
    expect(status.upstream).toBeNull()
    expect(status.ahead).toBe(0)
    expect(status.detached).toBe(false)
  })

  test('counts commits either side of the upstream', async () => {
    const { directory, git } = await scratchRepo()
    const branch = (await git.raw(['branch', '--show-current'])).trim()
    await git.raw(['branch', 'upstream-copy'])
    await git.raw(['branch', '--set-upstream-to', 'upstream-copy'])
    await writeFile(join(directory, 'extra.txt'), 'extra\n')
    await git.add('extra.txt')
    await git.commit('ahead')

    const status = await branchStatus(directory)
    expect(status).toEqual({
      branch,
      detached: false,
      upstream: 'upstream-copy',
      ahead: 1,
      behind: 0
    })
  })
})
