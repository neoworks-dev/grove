// The commits view reads a branch's history against its upstream: which of its
// commits are unpushed, which of the upstream's are incoming, and what each
// commit changed. Run against real repositories, one cloned from another so
// the upstream is a genuine remote-tracking branch.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  branchCommits,
  commitFiles,
  commitMessage,
  graphCommits,
  parseCommitQuery,
  parseLog,
  searchCommits
} from '../src/main/history'

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

describe('graphCommits', () => {
  test('walks every branch, children before parents, and names HEAD', async () => {
    const { directory, git } = await repository()
    await commitFile(directory, git, 'a.txt', 'a', 'root')
    await git.checkoutLocalBranch('side')
    await commitFile(directory, git, 'b.txt', 'b', 'on side')
    await git.checkout('-')
    await commitFile(directory, git, 'c.txt', 'c', 'on main')

    const page = await graphCommits(directory, 0, 10)
    const subjects = page.commits.map((commit) => commit.subject)
    expect(subjects).toContain('on side')
    expect(subjects.at(-1)).toBe('root')
    expect(page.head).toBe((await git.revparse(['HEAD'])).trim())
    expect(page.hasMore).toBe(false)

    const firstPage = await graphCommits(directory, 0, 2)
    expect(firstPage.commits).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
  })
})

describe('commitMessage', () => {
  test('returns subject and body', async () => {
    const { directory, git } = await repository()
    await writeFile(join(directory, 'a.txt'), 'a')
    await git.add('a.txt')
    await git.commit(['subject line', 'the body'])
    expect(await commitMessage(directory, 'HEAD')).toBe('subject line\n\nthe body')
  })
})

describe('parseCommitQuery', () => {
  test('sorts terms by operator; bare words and unknown prefixes search messages', () => {
    const query = parseCommitQuery('fix @:ada author:"Bob Smith" ?:src/main ~:foo\\( #:abc1 see:x')
    expect(query.messages).toEqual(['fix', 'see:x'])
    expect(query.authors).toEqual(['ada', 'Bob Smith'])
    expect(query.files).toEqual(['src/main'])
    expect(query.shas).toEqual(['abc1'])
    expect(query.change).toBe('foo\\(')
  })
})

describe('searchCommits', () => {
  /** Three commits by two authors across two files. */
  async function history(): Promise<{ directory: string; git: SimpleGit }> {
    const repo = await repository()
    await commitFile(repo.directory, repo.git, 'readme.md', 'hello\n', 'Add readme')
    await mkdir(join(repo.directory, 'src'))
    await commitFile(repo.directory, repo.git, 'src/Main.ts', 'let answer = 42\n', 'Fix [the] answer')
    await writeFile(join(repo.directory, 'readme.md'), 'hello world\n')
    await repo.git.add('readme.md')
    await repo.git.commit('Fix readme', undefined, { '--author': 'Ada Lovelace <ada@x>' })
    return repo
  }

  /** The subjects a search finds. */
  async function subjects(directory: string, text: string): Promise<string[]> {
    const page = await searchCommits(directory, text, 0, 10)
    return page.commits.map((commit) => commit.subject)
  }

  test('matches messages literally and case-insensitively, every term required', async () => {
    const { directory } = await history()
    expect(await subjects(directory, 'fix')).toEqual(['Fix readme', 'Fix [the] answer'])
    expect(await subjects(directory, '[the]')).toEqual(['Fix [the] answer'])
    expect(await subjects(directory, 'fix readme')).toEqual(['Fix readme'])
  })

  test('matches authors, file paths, content changes and SHAs', async () => {
    const { directory, git } = await history()
    expect(await subjects(directory, '@:ada')).toEqual(['Fix readme'])
    expect(await subjects(directory, 'fix @:ada')).toEqual(['Fix readme'])
    expect(await subjects(directory, '?:main')).toEqual(['Fix [the] answer'])
    expect(await subjects(directory, '~:answer')).toEqual(['Fix [the] answer'])
    const root = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim()
    expect(await subjects(directory, `#:${root.slice(0, 7)}`)).toEqual(['Add readme'])
    expect(await subjects(directory, '#:deadbeef')).toEqual([])
  })

  test('an empty query finds nothing', async () => {
    const { directory } = await history()
    expect(await subjects(directory, '   ')).toEqual([])
  })
})
