// The commits view reads a branch's history against its upstream: which of its
// commits are unpushed, which of the upstream's are incoming, and what each
// commit changed. Run against real repositories, one cloned from another so
// the upstream is a genuine remote-tracking branch.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'

import { branchCommits, commitFiles, parseLog } from '../src/main/history'

/** An empty repository with an identity to commit as. */
async function repository(): Promise<{ directory: string; git: SimpleGit }> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-history-'))
  const git = simpleGit({ baseDir: directory })
  await git.init()
  await identify(git)
  return { directory, git }
}

/** Sets a local identity so commits do not depend on the machine's config. */
async function identify(git: SimpleGit): Promise<void> {
  await git.addConfig('user.name', 'Grove Test')
  await git.addConfig('user.email', 'test@grove.invalid')
}

/** Writes a file and commits it with a subject. */
async function commitFile(
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

/** A clone of `origin` tracking its branch, with an identity of its own. */
async function cloneOf(origin: string): Promise<{ directory: string; git: SimpleGit }> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-history-clone-'))
  await simpleGit().clone(origin, directory)
  const git = simpleGit({ baseDir: directory })
  await identify(git)
  return { directory, git }
}

describe('parseLog', () => {
  test('splits records and fields, and a root commit has no parents', () => {
    const output = [
      ['a1', 'a', 'b2', 'Ada', 'ada@x', '2026-01-02T03:04:05+00:00', 'second'].join('\x1f'),
      '\x1e\n',
      ['b2', 'b', '', 'Ada', 'ada@x', '2026-01-01T03:04:05+00:00', 'first: with | pipes'].join(
        '\x1f'
      ),
      '\x1e\n'
    ].join('')
    const commits = parseLog(output)
    expect(commits.map((commit) => commit.subject)).toEqual(['second', 'first: with | pipes'])
    expect(commits[0].parents).toEqual(['b2'])
    expect(commits[1].parents).toEqual([])
  })
})

describe('branchCommits', () => {
  test('a branch with no commits has no history', async () => {
    const { directory } = await repository()
    expect(await branchCommits(directory, 0, 10)).toEqual({
      commits: [],
      unpushed: [],
      incoming: [],
      hasMore: false
    })
  })

  test('pages newest first and says when there is more', async () => {
    const { directory, git } = await repository()
    for (const name of ['one', 'two', 'three']) {
      await commitFile(directory, git, `${name}.txt`, name, name)
    }
    const first = await branchCommits(directory, 0, 2)
    expect(first.commits.map((commit) => commit.subject)).toEqual(['three', 'two'])
    expect(first.hasMore).toBe(true)
    const second = await branchCommits(directory, 2, 2)
    expect(second.commits.map((commit) => commit.subject)).toEqual(['one'])
    expect(second.hasMore).toBe(false)
  })

  test('with no remote at all, every commit is unpushed', async () => {
    const { directory, git } = await repository()
    await commitFile(directory, git, 'a.txt', 'a', 'only')
    const result = await branchCommits(directory, 0, 10)
    expect(result.unpushed).toEqual([result.commits[0].sha])
  })

  test('marks unpushed commits and lists incoming ones against the upstream', async () => {
    const origin = await repository()
    await commitFile(origin.directory, origin.git, 'base.txt', 'base', 'base')
    const clone = await cloneOf(origin.directory)

    await commitFile(clone.directory, clone.git, 'mine.txt', 'mine', 'mine')
    await commitFile(origin.directory, origin.git, 'theirs.txt', 'theirs', 'theirs')
    await clone.git.fetch()

    const result = await branchCommits(clone.directory, 0, 10)
    expect(result.commits.map((commit) => commit.subject)).toEqual(['mine', 'base'])
    expect(result.unpushed).toEqual([result.commits[0].sha])
    expect(result.incoming.map((commit) => commit.subject)).toEqual(['theirs'])
  })
})

describe('commitFiles', () => {
  test('lists what a commit changed, the root commit included', async () => {
    const { directory, git } = await repository()
    await commitFile(directory, git, 'a.txt', 'a\n', 'root')
    await writeFile(join(directory, 'a.txt'), 'a changed\n')
    await writeFile(join(directory, 'b.txt'), 'b\n')
    await git.add(['a.txt', 'b.txt'])
    await git.commit('second')

    const [second, root] = (await branchCommits(directory, 0, 10)).commits
    expect(await commitFiles(directory, root.sha)).toEqual([
      { path: 'a.txt', changeType: 'added', staged: false }
    ])
    expect(await commitFiles(directory, second.sha)).toEqual([
      { path: 'a.txt', changeType: 'modified', staged: false },
      { path: 'b.txt', changeType: 'added', staged: false }
    ])
  })
})
