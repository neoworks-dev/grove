// Conflict parsing runs against the markers in the working tree, so the cases
// that matter are the ones a real merge produces and a hand-edited file leaves
// behind: diff3's extra base section, CRLF, a conflict with no trailing
// newline, and a file that merely contains marker-like text.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  applyConflictChoice,
  listConflicts,
  parseConflictHunks,
  resolveConflictHunk
} from '../src/main/conflicts'
import { continueMerge, mergeInProgress, mergeWorktree } from '../src/main/git'

const TWO_SIDED = [
  'const port = 3000',
  '<<<<<<< HEAD',
  'const host = "localhost"',
  '=======',
  'const host = "127.0.0.1"',
  '>>>>>>> feature/greeting',
  'export { port, host }',
  ''
].join('\n')

describe('parseConflictHunks', () => {
  test('reads both sides, their labels and the marker lines', () => {
    expect(parseConflictHunks(TWO_SIDED)).toEqual([
      {
        startLine: 2,
        endLine: 6,
        oursLabel: 'HEAD',
        theirsLabel: 'feature/greeting',
        ours: ['const host = "localhost"'],
        theirs: ['const host = "127.0.0.1"']
      }
    ])
  })

  test('a file with no markers has no conflicts', () => {
    expect(parseConflictHunks('a\nb\nc\n')).toEqual([])
  })

  test('diff3 style carries the common ancestor as well', () => {
    const content = [
      '<<<<<<< ours',
      'mine',
      '||||||| base',
      'original',
      '=======',
      'yours',
      '>>>>>>> theirs',
      ''
    ].join('\n')

    const [hunk] = parseConflictHunks(content)
    expect(hunk.ours).toEqual(['mine'])
    expect(hunk.base).toEqual(['original'])
    expect(hunk.theirs).toEqual(['yours'])
  })

  test('two conflicts in one file are reported in order', () => {
    const content = [
      '<<<<<<< HEAD',
      'one',
      '=======',
      'uno',
      '>>>>>>> other',
      'middle',
      '<<<<<<< HEAD',
      'two',
      '=======',
      'dos',
      '>>>>>>> other',
      ''
    ].join('\n')

    const hunks = parseConflictHunks(content)
    expect(hunks.map((hunk) => [hunk.startLine, hunk.endLine])).toEqual([
      [1, 5],
      [7, 11]
    ])
  })

  test('an opening marker that never closes is not a conflict', () => {
    const content = ['<<<<<<< not really', 'the rest of the file', ''].join('\n')
    expect(parseConflictHunks(content)).toEqual([])
  })

  test('markers are recognised on a CRLF file, and bodies keep their endings', () => {
    const content = [
      '<<<<<<< HEAD\r',
      'mine\r',
      '=======\r',
      'yours\r',
      '>>>>>>> other\r',
      ''
    ].join('\n')

    const [hunk] = parseConflictHunks(content)
    expect(hunk.ours).toEqual(['mine\r'])
    expect(hunk.theirs).toEqual(['yours\r'])
  })

  test('a conflict closing the file without a trailing newline still parses', () => {
    const content = ['<<<<<<< HEAD', 'mine', '=======', 'yours', '>>>>>>> other'].join('\n')
    expect(parseConflictHunks(content)).toHaveLength(1)
  })

  test('a marker with no label reports an empty one', () => {
    const content = ['<<<<<<<', 'mine', '=======', 'yours', '>>>>>>>', ''].join('\n')
    const [hunk] = parseConflictHunks(content)
    expect(hunk.oursLabel).toBe('')
    expect(hunk.theirsLabel).toBe('')
  })
})

describe('applyConflictChoice', () => {
  test('ours keeps the local side and drops the markers', () => {
    expect(applyConflictChoice(TWO_SIDED, 0, 'ours')).toBe(
      ['const port = 3000', 'const host = "localhost"', 'export { port, host }', ''].join('\n')
    )
  })

  test('theirs keeps the incoming side', () => {
    expect(applyConflictChoice(TWO_SIDED, 0, 'theirs')).toBe(
      ['const port = 3000', 'const host = "127.0.0.1"', 'export { port, host }', ''].join('\n')
    )
  })

  test('both keeps ours first, then theirs', () => {
    expect(applyConflictChoice(TWO_SIDED, 0, 'both')).toBe(
      [
        'const port = 3000',
        'const host = "localhost"',
        'const host = "127.0.0.1"',
        'export { port, host }',
        ''
      ].join('\n')
    )
  })

  test('resolving one conflict leaves the other one alone', () => {
    const content = [
      '<<<<<<< HEAD',
      'one',
      '=======',
      'uno',
      '>>>>>>> other',
      '<<<<<<< HEAD',
      'two',
      '=======',
      'dos',
      '>>>>>>> other',
      ''
    ].join('\n')

    const resolved = applyConflictChoice(content, 0, 'ours')
    expect(resolved).toBe(
      ['one', '<<<<<<< HEAD', 'two', '=======', 'dos', '>>>>>>> other', ''].join('\n')
    )
    expect(parseConflictHunks(resolved)).toHaveLength(1)
  })

  test('the diff3 base section goes with the markers', () => {
    const content = [
      '<<<<<<< ours',
      'mine',
      '||||||| base',
      'original',
      '=======',
      'yours',
      '>>>>>>> theirs',
      ''
    ].join('\n')

    expect(applyConflictChoice(content, 0, 'theirs')).toBe(['yours', ''].join('\n'))
  })

  test('a file that ended without a newline still does', () => {
    const content = ['<<<<<<< HEAD', 'mine', '=======', 'yours', '>>>>>>> other'].join('\n')
    expect(applyConflictChoice(content, 0, 'ours')).toBe('mine')
  })

  test('an index the file does not have is refused', () => {
    expect(() => applyConflictChoice(TWO_SIDED, 3, 'ours')).toThrow(/not in this file/)
  })
})

describe('resolveConflictHunk', () => {
  test('writes the resolution back and reports what is left', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grove-conflicts-'))
    const content = [
      '<<<<<<< HEAD',
      'one',
      '=======',
      'uno',
      '>>>>>>> other',
      '<<<<<<< HEAD',
      'two',
      '=======',
      'dos',
      '>>>>>>> other',
      ''
    ].join('\n')
    await writeFile(join(root, 'config.ts'), content, 'utf8')

    const remaining = await resolveConflictHunk(root, 'config.ts', 0, 'theirs')

    expect(remaining).toHaveLength(1)
    expect(remaining[0].ours).toEqual(['two'])
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(
      ['uno', '<<<<<<< HEAD', 'two', '=======', 'dos', '>>>>>>> other', ''].join('\n')
    )
  })

  test('a path leaving the worktree is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grove-conflicts-'))
    await expect(resolveConflictHunk(root, '../escape.ts', 0, 'ours')).rejects.toThrow(
      /outside worktree/
    )
  })
})

// A repo whose `feature` branch changes the same lines as `main`, so merging it
// produces the markers git really writes rather than the ones this test hopes
// for.
async function conflictedRepo(): Promise<{ root: string; git: SimpleGit }> {
  const root = await mkdtemp(join(tmpdir(), 'grove-conflict-repo-'))
  const git = simpleGit({ baseDir: root })
  await git.init(['-b', 'main'])
  await git.addConfig('user.email', 'test@grove.local')
  await git.addConfig('user.name', 'Test')
  await git.addConfig('commit.gpgsign', 'false')
  await writeFile(join(root, 'greeting.txt'), 'hello\nworld\n')
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', 'base'])

  await git.raw(['checkout', '-b', 'feature'])
  await writeFile(join(root, 'greeting.txt'), 'hello\nfrom feature\n')
  await git.raw(['commit', '-am', 'feature greeting'])

  await git.raw(['checkout', 'main'])
  await writeFile(join(root, 'greeting.txt'), 'hello\nfrom main\n')
  await git.raw(['commit', '-am', 'main greeting'])

  return { root, git }
}

describe('against a real merge', () => {
  test('a conflict git produced is described, resolved and committed', async () => {
    const { root, git } = await conflictedRepo()

    const merge = await mergeWorktree(root, 'feature', { mode: 'no-ff' })
    expect(merge.status).toBe('conflict')

    const files = await listConflicts(root)
    expect(files.map((file) => file.path)).toEqual(['greeting.txt'])
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].ours).toEqual(['from main'])
    expect(files[0].hunks[0].theirs).toEqual(['from feature'])

    const remaining = await resolveConflictHunk(root, 'greeting.txt', 0, 'theirs')
    expect(remaining).toEqual([])
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello\nfrom feature\n')

    await git.raw(['add', 'greeting.txt'])
    expect(await listConflicts(root)).toEqual([])
    expect((await continueMerge(root)).status).toBe('merged')
  })

  test('the merge is in progress until it is committed', async () => {
    const { root, git } = await conflictedRepo()
    expect(await mergeInProgress(root)).toBe(false)

    await mergeWorktree(root, 'feature', { mode: 'no-ff' })
    expect(await mergeInProgress(root)).toBe(true)

    // Still open with every conflict resolved and staged — which is when the
    // only thing left to offer is finishing it.
    await resolveConflictHunk(root, 'greeting.txt', 0, 'ours')
    await git.raw(['add', 'greeting.txt'])
    expect(await mergeInProgress(root)).toBe(true)

    await continueMerge(root)
    expect(await mergeInProgress(root)).toBe(false)
  })
})
