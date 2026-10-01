// Resolving merge conflicts with an agent: the prompt it is given, the
// proposals it makes through its tool, and writing back what the user settled.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import {
  ConflictProposals,
  applyResolutions,
  resolutionLines,
  resolutionPrompt,
  writeResolutions
} from '../src/main/conflictResolution'
import { conflictTool } from '../src/main/agents/tools/conflictTools'
import { parseConflictHunks } from '../src/main/conflicts'
import {
  hunkKey,
  previewResolutions,
  reviewedFiles,
  resolutionsToWrite,
  settledCount,
  sideLines
} from '../src/renderer/src/lib/conflictDecisions'

const cleanups: string[] = []

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A repository mid-merge, with one conflict in greet.ts and one in two.ts. */
async function conflictedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grove-conflict-agent-'))
  cleanups.push(dir)
  const git = simpleGit({ baseDir: dir })
  await git.init(['-b', 'main'])
  await git.addConfig('user.email', 'test@grove.local')
  await git.addConfig('user.name', 'Test')
  await git.addConfig('commit.gpgsign', 'false')
  await writeFile(join(dir, 'greet.ts'), 'export const greeting = "hello"\n')
  await writeFile(join(dir, 'two.ts'), 'a\nb\nc\n')
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', 'base'])

  await git.raw(['checkout', '-b', 'feature'])
  await writeFile(join(dir, 'greet.ts'), 'export const greeting = "hello, world"\n')
  await writeFile(join(dir, 'two.ts'), 'a\nB from feature\nc\n')
  await git.raw(['commit', '-am', 'feature: widen the greeting'])

  await git.raw(['checkout', 'main'])
  await writeFile(join(dir, 'greet.ts'), 'export const greeting = "Hello"\n')
  await writeFile(join(dir, 'two.ts'), 'a\nB from main\nc\n')
  await git.raw(['commit', '-am', 'main: capitalise the greeting'])
  await git.raw(['merge', 'feature']).catch(() => {})
  return dir
}

function recorder(): { proposals: ConflictProposals; published: string[] } {
  const published: string[] = []
  const proposals = new ConflictProposals({ publish: (path) => published.push(path) })
  return { proposals, published }
}

const context = (root: string) => ({
  sessionId: 'session-1',
  workspaceRoot: root,
  surface: () => {},
  show: () => {}
})

describe('the prompt', () => {
  test('quotes every conflict and each side history', async () => {
    const repo = await conflictedRepo()
    const prompt = await resolutionPrompt(repo, null)
    expect(prompt).toContain('merging')
    expect(prompt).toContain('greet.ts, conflict 1')
    expect(prompt).toContain('export const greeting = "Hello"')
    expect(prompt).toContain('export const greeting = "hello, world"')
    expect(prompt).toContain('main: capitalise the greeting')
    expect(prompt).toContain('feature: widen the greeting')
    expect(prompt).toContain('propose_conflict_resolution')
  })

  test('can be narrowed to one file', async () => {
    const repo = await conflictedRepo()
    const prompt = await resolutionPrompt(repo, ['two.ts'])
    expect(prompt).toContain('two.ts, conflict 1')
    expect(prompt).not.toContain('greet.ts, conflict 1')
  })
})

describe('proposing through the tool', () => {
  test('records a proposal for a conflict that exists', async () => {
    const repo = await conflictedRepo()
    const { proposals, published } = recorder()
    const result = await conflictTool(proposals).execute(
      {
        path: 'greet.ts',
        conflict: 1,
        resolution: 'export const greeting = "Hello, world"\n',
        reason: 'Keeps main capitalisation and the wider greeting from feature.',
        confident: true
      },
      context(repo)
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1 of 2')
    expect(published).toEqual([repo])

    const current = await proposals.current(repo)
    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({
      path: 'greet.ts',
      hunkIndex: 0,
      lines: ['export const greeting = "Hello, world"'],
      confident: true,
      sessionId: 'session-1'
    })
  })

  test('refuses a conflict that is not there, and a confident call with no resolution', async () => {
    const repo = await conflictedRepo()
    const { proposals } = recorder()
    const tool = conflictTool(proposals)
    const missing = await tool.execute(
      { path: 'greet.ts', conflict: 2, resolution: 'x', reason: 'r', confident: true },
      context(repo)
    )
    expect(missing.isError).toBe(true)
    const empty = await tool.execute(
      { path: 'greet.ts', conflict: 1, reason: 'r', confident: true },
      context(repo)
    )
    expect(empty.isError).toBe(true)
  })

  test('an unsure call is kept as a flag with nothing to apply', async () => {
    const repo = await conflictedRepo()
    const { proposals } = recorder()
    await conflictTool(proposals).execute(
      { path: 'two.ts', conflict: 1, reason: 'Both sides rename b differently.', confident: false },
      context(repo)
    )
    const [proposal] = await proposals.current(repo)
    expect(proposal.lines).toBeNull()
    expect(proposal.confident).toBe(false)
  })

  test('a proposal whose conflict was resolved meanwhile is dropped', async () => {
    const repo = await conflictedRepo()
    const { proposals } = recorder()
    await conflictTool(proposals).execute(
      { path: 'two.ts', conflict: 1, resolution: 'B', reason: 'r', confident: true },
      context(repo)
    )
    await writeFile(join(repo, 'two.ts'), 'a\nB by hand\nc\n')
    expect(await proposals.current(repo)).toEqual([])
  })
})

describe('writing back', () => {
  test('replaces each conflict and stages files left without markers', async () => {
    const repo = await conflictedRepo()
    const staged = await writeResolutions(repo, [
      { path: 'greet.ts', hunkIndex: 0, lines: ['export const greeting = "Hello, world"'] },
      { path: 'two.ts', hunkIndex: 0, lines: ['B from both'] }
    ])
    expect(staged.sort()).toEqual(['greet.ts', 'two.ts'])
    expect(await readFile(join(repo, 'greet.ts'), 'utf8')).toBe(
      'export const greeting = "Hello, world"\n'
    )
    const status = await simpleGit({ baseDir: repo }).raw(['status', '--porcelain'])
    expect(status).not.toContain('UU')
  })

  test('applies several conflicts in one file from the bottom up', () => {
    const content = [
      'top',
      '<<<<<<< HEAD',
      'one ours',
      '=======',
      'one theirs',
      '>>>>>>> other',
      'middle',
      '<<<<<<< HEAD',
      'two ours',
      '=======',
      'two theirs',
      '>>>>>>> other',
      'end'
    ].join('\n')
    const resolved = applyResolutions(content, [
      { hunkIndex: 0, lines: ['one', 'resolved'] },
      { hunkIndex: 1, lines: ['two'] }
    ])
    expect(resolved).toBe('top\none\nresolved\nmiddle\ntwo\nend')
    expect(parseConflictHunks(resolved)).toEqual([])
  })

  test('a CRLF file keeps its line endings', () => {
    const hunk = parseConflictHunks('<<<<<<< a\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n')[0]
    expect(resolutionLines('x\ny\n', hunk)).toEqual(['x\r', 'y\r'])
  })
})

describe('settling proposals in the renderer', () => {
  const hunk = (ours: string, theirs: string) => ({
    startLine: 1,
    endLine: 5,
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
    ours: [ours],
    theirs: [theirs]
  })
  const files = [
    { path: 'a.ts', hunks: [hunk('a1', 'b1'), hunk('a2', 'b2')] },
    { path: 'untouched.ts', hunks: [hunk('x', 'y')] }
  ]
  const proposals = [
    {
      path: 'a.ts',
      hunkIndex: 0,
      fingerprint: 'f',
      lines: ['merged'],
      reason: 'r',
      confident: true,
      sessionId: 's'
    }
  ]

  test('only files with a proposal are under review, every conflict in them counted', () => {
    expect(reviewedFiles(files, proposals).map((file) => file.path)).toEqual(['a.ts'])
    expect(settledCount(files, proposals, {})).toEqual({ settled: 0, total: 2 })
  })

  test('decisions are keyed to the conflict as it is, and write back as their lines', () => {
    const decisions = {
      [hunkKey('a.ts', 0, files[0].hunks[0])]: { kind: 'proposal' as const, lines: ['merged'] },
      [hunkKey('a.ts', 1, files[0].hunks[1])]: {
        kind: 'theirs' as const,
        lines: sideLines(files[0].hunks[1], 'theirs')
      }
    }
    expect(settledCount(files, proposals, decisions)).toEqual({ settled: 2, total: 2 })
    expect(resolutionsToWrite(files, proposals, decisions)).toEqual([
      { path: 'a.ts', hunkIndex: 0, lines: ['merged'] },
      { path: 'a.ts', hunkIndex: 1, lines: ['b2'] }
    ])
    expect(hunkKey('a.ts', 0, hunk('a1', 'changed'))).not.toBe(hunkKey('a.ts', 0, files[0].hunks[0]))
  })

  test('the preview fills undecided conflicts with the proposal, and leaves the rest', () => {
    expect(previewResolutions(files[0], proposals, {})).toEqual([
      { path: 'a.ts', hunkIndex: 0, lines: ['merged'] }
    ])
  })
})

describe('across a restart', () => {
  test('proposals are read back from their file', async () => {
    const repo = await conflictedRepo()
    const file = join(repo, '..', `proposals-${Date.now()}.json`)
    cleanups.push(file)
    const first = new ConflictProposals({ publish: () => {}, file })
    await conflictTool(first).execute(
      { path: 'greet.ts', conflict: 1, resolution: 'x', reason: 'r', confident: true },
      context(repo)
    )
    const second = new ConflictProposals({ publish: () => {}, file })
    expect((await second.current(repo)).map((proposal) => proposal.path)).toEqual(['greet.ts'])
  })
})
