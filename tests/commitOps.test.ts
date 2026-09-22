// The graph's actions on a single commit, run against real repositories. The
// cases that matter are the ones that stop part-way: a cherry-pick or revert
// that cannot finish must leave the branch exactly as it was.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  checkoutCommit,
  cherryPick,
  createBranch,
  reset,
  revert
} from '../src/main/commitOps'

/** A repository with a `side` branch diverging from `main` after one commit. */
async function diverged(): Promise<{ directory: string; git: SimpleGit }> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-commit-ops-'))
  const git = simpleGit({ baseDir: directory })
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.name', 'Grove Test')
  await git.addConfig('user.email', 'test@grove.invalid')
  await commit(directory, git, 'shared.txt', 'base\n', 'base')
  await git.checkoutLocalBranch('side')
  await commit(directory, git, 'side.txt', 'side\n', 'add side file')
  await commit(directory, git, 'shared.txt', 'side edit\n', 'edit shared on side')
  await git.checkout('main')
  await commit(directory, git, 'shared.txt', 'main edit\n', 'edit shared on main')
  return { directory, git }
}

/** Writes a file and commits it. */
async function commit(
  directory: string,
  git: SimpleGit,
  path: string,
  content: string,
  subject: string
): Promise<void> {
  await writeFile(join(directory, path), content)
  await git.add(path)
  await git.commit(subject)
}

/** The full SHA a revision names. */
async function sha(git: SimpleGit, revision: string): Promise<string> {
  return (await git.revparse([revision])).trim()
}

describe('cherryPick', () => {
  test('applies a commit from another branch', async () => {
    const { directory, git } = await diverged()
    await cherryPick(directory, await sha(git, 'side~1'))
    expect(await readFile(join(directory, 'side.txt'), 'utf8')).toBe('side\n')
    expect((await git.log()).latest?.message).toBe('add side file')
  })

  test('a conflicting cherry-pick is aborted and the branch is unchanged', async () => {
    const { directory, git } = await diverged()
    const before = await sha(git, 'HEAD')
    await expect(cherryPick(directory, await sha(git, 'side'))).rejects.toThrow(
      /conflicts in shared.txt/
    )
    expect(await sha(git, 'HEAD')).toBe(before)
    expect((await git.status()).isClean()).toBe(true)
  })

  test('picking a change that is already there is aborted too', async () => {
    const { directory, git } = await diverged()
    const before = await sha(git, 'HEAD')
    await expect(cherryPick(directory, before)).rejects.toThrow(/aborted/)
    expect(await sha(git, 'HEAD')).toBe(before)
  })
})

describe('revert', () => {
  test('adds a commit undoing one', async () => {
    const { directory, git } = await diverged()
    await revert(directory, await sha(git, 'HEAD'))
    expect(await readFile(join(directory, 'shared.txt'), 'utf8')).toBe('base\n')
  })
})

describe('branches and resets', () => {
  test('creates a branch at a commit, optionally switching to it', async () => {
    const { directory, git } = await diverged()
    const base = await sha(git, 'main~1')
    await createBranch(directory, 'kept', base, false)
    expect(await sha(git, 'kept')).toBe(base)
    expect((await git.branch()).current).toBe('main')
    await createBranch(directory, 'switched', base, true)
    expect((await git.branch()).current).toBe('switched')
  })

  test('checks a commit out detached', async () => {
    const { directory, git } = await diverged()
    const base = await sha(git, 'main~1')
    await checkoutCommit(directory, base)
    expect(await sha(git, 'HEAD')).toBe(base)
    expect((await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim()).toBe('')
  })

  test('a soft reset keeps the change staged', async () => {
    const { directory, git } = await diverged()
    await reset(directory, await sha(git, 'main~1'), 'soft')
    expect((await git.status()).staged).toEqual(['shared.txt'])
  })
})
