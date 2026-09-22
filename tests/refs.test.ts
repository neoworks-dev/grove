// Branches, tags, stashes and comparisons, read from real repositories: one
// cloned from another, so the remote-tracking branches and upstream counts are
// what git itself reports.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  checkout,
  compareRefs,
  listRefs,
  listStashes,
  parseTrack,
  rebaseOnto,
  stashApply,
  stashPush
} from '../src/main/refs'

interface Repository {
  directory: string
  git: SimpleGit
}

/** A repository on `main` with one commit, and an identity to commit as. */
async function repository(): Promise<Repository> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-refs-'))
  const git = simpleGit({ baseDir: directory })
  await git.raw(['init', '--initial-branch=main'])
  await identify(git)
  await commitFile({ directory, git }, 'base.txt', 'base\n', 'base')
  return { directory, git }
}

/** Sets a local identity so commits do not depend on the machine's config. */
async function identify(git: SimpleGit): Promise<void> {
  await git.addConfig('user.name', 'Grove Test')
  await git.addConfig('user.email', 'test@grove.invalid')
}

/** Writes a file and commits it with a subject. */
async function commitFile(
  repo: Repository,
  path: string,
  content: string,
  subject: string
): Promise<void> {
  await writeFile(join(repo.directory, path), content)
  await repo.git.add(path)
  await repo.git.commit(subject)
}

/** A clone of `origin`, with an identity of its own. */
async function cloneOf(origin: Repository): Promise<Repository> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-refs-clone-'))
  await simpleGit().clone(origin.directory, directory)
  const git = simpleGit({ baseDir: directory })
  await identify(git)
  return { directory, git }
}

describe('parseTrack', () => {
  test('reads counts either side, and a deleted upstream', () => {
    expect(parseTrack('ahead 2, behind 1')).toEqual({ ahead: 2, behind: 1, upstreamGone: false })
    expect(parseTrack('behind 3')).toEqual({ ahead: 0, behind: 3, upstreamGone: false })
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, upstreamGone: true })
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, upstreamGone: false })
  })
})

describe('listRefs', () => {
  test('sorts local and remote branches and tags, and skips origin/HEAD', async () => {
    const origin = await repository()
    await origin.git.raw(['branch', 'feature'])
    const clone = await cloneOf(origin)
    await commitFile(clone, 'mine.txt', 'mine\n', 'mine')
    await clone.git.raw(['tag', 'light'])
    await clone.git.raw(['tag', '-a', 'annotated', '-m', 'release notes', 'HEAD~1'])

    const refs = await listRefs(clone.directory)

    const main = refs.local.find((branch) => branch.name === 'main')
    expect(main).toMatchObject({ current: true, upstream: 'origin/main', ahead: 1, behind: 0 })
    expect(main?.worktreePath).toBeTruthy()
    expect(refs.remote.map((branch) => branch.name).sort()).toEqual([
      'origin/feature',
      'origin/main'
    ])
    expect(refs.remote[0].remote).toBe('origin')

    const head = (await clone.git.raw(['rev-parse', 'HEAD'])).trim()
    const parent = (await clone.git.raw(['rev-parse', 'HEAD~1'])).trim()
    const annotated = refs.tags.find((tag) => tag.name === 'annotated')
    expect(annotated).toMatchObject({ sha: parent, subject: 'release notes' })
    expect(refs.tags.find((tag) => tag.name === 'light')?.sha).toBe(head)
  })
})

describe('checkout', () => {
  test('a remote branch checks out a local one tracking it', async () => {
    const origin = await repository()
    await origin.git.raw(['branch', 'feature'])
    const clone = await cloneOf(origin)

    await checkout(clone.directory, 'origin/feature', true)

    const refs = await listRefs(clone.directory)
    expect(refs.local.find((branch) => branch.current)).toMatchObject({
      name: 'feature',
      upstream: 'origin/feature'
    })
  })
})

describe('rebaseOnto', () => {
  test('rebases cleanly when nothing conflicts', async () => {
    const repo = await repository()
    await repo.git.raw(['switch', '-c', 'topic'])
    await commitFile(repo, 'topic.txt', 'topic\n', 'topic')
    await repo.git.raw(['switch', 'main'])
    await commitFile(repo, 'main.txt', 'main\n', 'main')
    await repo.git.raw(['switch', 'topic'])

    await rebaseOnto(repo.directory, 'main')

    const subjects = await repo.git.raw(['log', '--format=%s'])
    expect(subjects.trim().split('\n')).toEqual(['topic', 'main', 'base'])
  })

  test('a conflicting rebase is aborted and leaves the branch as it was', async () => {
    const repo = await repository()
    await repo.git.raw(['switch', '-c', 'topic'])
    await commitFile(repo, 'base.txt', 'topic side\n', 'topic edit')
    const before = (await repo.git.raw(['rev-parse', 'HEAD'])).trim()
    await repo.git.raw(['switch', 'main'])
    await commitFile(repo, 'base.txt', 'main side\n', 'main edit')
    await repo.git.raw(['switch', 'topic'])

    await expect(rebaseOnto(repo.directory, 'main')).rejects.toThrow(
      'stopped on conflicts in base.txt'
    )

    expect((await repo.git.raw(['rev-parse', 'HEAD'])).trim()).toBe(before)
    expect(await readFile(join(repo.directory, 'base.txt'), 'utf8')).toBe('topic side\n')
    const status = await repo.git.raw(['status', '--porcelain'])
    expect(status.trim()).toBe('')
  })
})

describe('stashes', () => {
  test('stashes untracked work, lists it, and applies it back', async () => {
    const repo = await repository()
    await writeFile(join(repo.directory, 'base.txt'), 'edited\n')
    await writeFile(join(repo.directory, 'new.txt'), 'new\n')

    await stashPush(repo.directory, 'halfway there')
    const stashes = await listStashes(repo.directory)
    expect(stashes).toHaveLength(1)
    expect(stashes[0].ref).toBe('stash@{0}')
    expect(stashes[0].commit.subject).toContain('halfway there')
    expect((await repo.git.raw(['status', '--porcelain'])).trim()).toBe('')

    await stashApply(repo.directory, stashes[0].ref, true)
    expect(await readFile(join(repo.directory, 'new.txt'), 'utf8')).toBe('new\n')
    expect(await listStashes(repo.directory)).toEqual([])
  })
})

describe('compareRefs', () => {
  test('lists commits either side and the files between two refs', async () => {
    const repo = await repository()
    await repo.git.raw(['switch', '-c', 'topic'])
    await commitFile(repo, 'topic.txt', 'topic\n', 'topic')
    await repo.git.raw(['switch', 'main'])
    await commitFile(repo, 'main.txt', 'main\n', 'main')

    const result = await compareRefs(repo.directory, 'main', 'topic')
    expect(result.ahead.map((commit) => commit.subject)).toEqual(['topic'])
    expect(result.behind.map((commit) => commit.subject)).toEqual(['main'])
    expect(result.files.map((file) => [file.path, file.changeType])).toEqual([
      ['main.txt', 'deleted'],
      ['topic.txt', 'added']
    ])
  })

  test('against the working tree, uncommitted edits count', async () => {
    const repo = await repository()
    await writeFile(join(repo.directory, 'base.txt'), 'edited\n')

    const result = await compareRefs(repo.directory, 'main', null)
    expect(result.ahead).toEqual([])
    expect(result.files).toEqual([{ path: 'base.txt', changeType: 'modified', staged: false }])
  })
})
