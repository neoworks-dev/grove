// Blaming a line to the agent prompt that wrote it: through commits, squashes
// and the session's deletion, and not for lines a person wrote.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { captureTree } from '../src/main/checkpoints'
import {
  PromptBlame,
  addedLinesByFile,
  lineKey,
  narrowedRecords,
  parseBlamePorcelain,
  type StoredAttribution
} from '../src/main/promptBlame'
import { PROMPT_NOTES_REF, readNote, withProblems } from '../src/main/promptNotes'
import { blameLabel, promptHeadline } from '../src/renderer/src/lib/agents/blameLabel'
import { sectionHolding } from '../src/renderer/src/lib/agents/sectionHolding'
import type { AgentEditStep } from '../src/shared/agents'

const cleanups: string[] = []

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

async function scratchRepo(): Promise<string> {
  const dir = await scratchDir('grove-blame-repo-')
  const git = simpleGit({ baseDir: dir })
  await git.init()
  await git.addConfig('user.email', 'test@grove.local')
  await git.addConfig('user.name', 'Person')
  await git.addConfig('commit.gpgsign', 'false')
  await writeFile(join(dir, 'app.ts'), 'const first = 1\n')
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', 'init'])
  return dir
}

/** Makes `write` as an agent step of session "s1", recorded with its prompt. */
async function agentEdit(
  blame: PromptBlame,
  repo: string,
  write: () => Promise<void>,
  prompt: string
): Promise<void> {
  const before = await captureTree(repo)
  await write()
  const after = await captureTree(repo)
  const step: AgentEditStep = {
    index: 1,
    turnSeq: 4,
    seq: 5,
    toolCallId: 'c1',
    title: 'Edit app.ts',
    kind: 'edit',
    at: new Date(Date.now() - 5000).toISOString(),
    before,
    after,
    files: []
  }
  await blame.recordStep(
    repo,
    { id: 's1', title: 'Add the second constant', harness: 'claude' },
    step,
    { from: 'You', prompt }
  )
}

async function commitAll(repo: string, message: string): Promise<void> {
  const git = simpleGit({ baseDir: repo })
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', message])
}

async function setup(
  sessions: Set<string> = new Set(['s1']),
  sharing = false
): Promise<{
  repo: string
  blame: PromptBlame
}> {
  const repo = await scratchRepo()
  const blame = new PromptBlame({
    directory: await scratchDir('grove-blame-store-'),
    sessionExists: (sessionId) => sessions.has(sessionId),
    sharingNotes: () => sharing
  })
  await agentEdit(
    blame,
    repo,
    () => writeFile(join(repo, 'app.ts'), 'const first = 1\nconst second = 2\n'),
    'add a second constant'
  )
  return { repo, blame }
}

describe('blaming a line to its prompt', () => {
  test('an uncommitted line the agent wrote names the prompt and no commit', async () => {
    const { repo, blame } = await setup()
    const result = await blame.blameLine(repo, 'app.ts', 2, 'const second = 2')
    expect(result.commit).toBeNull()
    expect(result.prompt).toMatchObject({
      sessionId: 's1',
      sessionTitle: 'Add the second constant',
      turnSeq: 4,
      from: 'You',
      prompt: 'add a second constant',
      sessionExists: true
    })
  })

  test('a line a person wrote has a commit and no prompt', async () => {
    const { repo, blame } = await setup()
    const result = await blame.blameLine(repo, 'app.ts', 1, 'const first = 1')
    expect(result.commit?.summary).toBe('init')
    expect(result.prompt).toBeNull()
  })

  test('the prompt stays with the line once it is committed, and after a squash', async () => {
    const { repo, blame } = await setup()
    await commitAll(repo, 'second constant')
    await writeFile(join(repo, 'app.ts'), 'const first = 1\nconst second = 2\nconst third = 3\n')
    await commitAll(repo, 'third constant')
    const git = simpleGit({ baseDir: repo })
    await git.raw(['reset', '--soft', 'HEAD~2'])
    await git.raw(['commit', '-m', 'squashed'])

    const result = await blame.blameLine(repo, 'app.ts', 2, 'const second = 2')
    expect(result.commit?.summary).toBe('squashed')
    expect(result.prompt?.prompt).toBe('add a second constant')
  })

  test('a person rewriting the line takes it back', async () => {
    const { repo, blame } = await setup()
    await commitAll(repo, 'second constant')
    await writeFile(join(repo, 'app.ts'), 'const first = 1\nconst second = 22\n')
    const result = await blame.blameLine(repo, 'app.ts', 2, 'const second = 22')
    expect(result.prompt).toBeNull()
  })

  test('the prompt survives the session being deleted', async () => {
    const sessions = new Set(['s1'])
    const { repo, blame } = await setup(sessions)
    sessions.delete('s1')
    const result = await blame.blameLine(repo, 'app.ts', 2, 'const second = 2')
    expect(result.prompt?.prompt).toBe('add a second constant')
    expect(result.prompt?.sessionExists).toBe(false)
  })

  test('a fresh instance reads the records back from disk', async () => {
    const { repo, blame } = await setup()
    const directory = (blame as unknown as { options: { directory: string } }).options.directory
    const fresh = new PromptBlame({ directory, sessionExists: () => true, sharingNotes: () => false })
    const result = await fresh.blameLine(repo, 'app.ts', 2, 'const second = 2')
    expect(result.prompt?.prompt).toBe('add a second constant')
  })
})

describe("a commit's prompts", () => {
  test('lists the prompts behind its added lines', async () => {
    const { repo, blame } = await setup()
    await commitAll(repo, 'second constant')
    const sha = (await simpleGit({ baseDir: repo }).raw(['rev-parse', 'HEAD'])).trim()
    const prompts = await blame.commitPrompts(repo, sha)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ prompt: 'add a second constant', lines: 1 })
  })

  test('a commit without the agent\'s lines claims no prompt', async () => {
    const { repo, blame } = await setup()
    const sha = (await simpleGit({ baseDir: repo }).raw(['rev-parse', 'HEAD'])).trim()
    expect(await blame.commitPrompts(repo, sha)).toEqual([])
  })
})

/** A bare repository as `origin`, with the scratch repo's branch pushed to it. */
async function withRemote(repo: string): Promise<string> {
  const remote = await scratchDir('grove-blame-remote-')
  await simpleGit({ baseDir: remote }).raw(['init', '--bare'])
  const git = simpleGit({ baseDir: repo })
  await git.raw(['remote', 'add', 'origin', remote])
  return remote
}

/** A teammate's clone of `remote`, with prompt blame of their own and no local records. */
async function teammateClone(remote: string): Promise<{ clone: string; blame: PromptBlame }> {
  const clone = join(await scratchDir('grove-blame-teammate-'), 'repo')
  await simpleGit().raw(['clone', remote, clone])
  const git = simpleGit({ baseDir: clone })
  await git.addConfig('user.email', 'mate@grove.local')
  await git.addConfig('user.name', 'Teammate')
  const blame = new PromptBlame({
    directory: await scratchDir('grove-blame-mate-store-'),
    sessionExists: () => false,
    sharingNotes: () => true
  })
  return { clone, blame }
}

/** Pushes HEAD the way the push route does, with prompt notes around it. */
async function pushWithNotes(blame: PromptBlame, repo: string): Promise<string[]> {
  const problems = [await blame.prepareToPublish(repo)]
  await simpleGit({ baseDir: repo }).raw(['push', '-u', 'origin', 'HEAD'])
  problems.push(await blame.publishNotes(repo, 'origin'))
  return problems.filter((problem) => problem.length > 0)
}

async function headSha(repo: string): Promise<string> {
  return (await simpleGit({ baseDir: repo }).raw(['rev-parse', 'HEAD'])).trim()
}

describe('sharing prompt blame through git notes', () => {
  test("a teammate's clone blames the line to the prompt", async () => {
    const { repo, blame } = await setup(new Set(['s1']), true)
    await commitAll(repo, 'second constant')
    const remote = await withRemote(repo)
    expect(await pushWithNotes(blame, repo)).toEqual([])

    const mate = await teammateClone(remote)
    expect(await mate.blame.receiveNotes(mate.clone, 'origin')).toBe('')
    const result = await mate.blame.blameLine(mate.clone, 'app.ts', 2, 'const second = 2')
    expect(result.commit?.summary).toBe('second constant')
    expect(result.prompt).toMatchObject({ prompt: 'add a second constant', sessionExists: false })
    expect(await mate.blame.commitPrompts(mate.clone, await headSha(mate.clone))).toMatchObject([
      { prompt: 'add a second constant', lines: 1 }
    ])
  })

  test('the note holds only the lines the commit added', async () => {
    const { repo, blame } = await setup(new Set(['s1']), true)
    await commitAll(repo, 'second constant')
    await blame.prepareToPublish(repo)
    const note = await readNote(repo, await headSha(repo))
    expect(note).toHaveLength(1)
    const record: StoredAttribution = JSON.parse(note[0])
    expect(record.files).toEqual({ 'app.ts': [lineKey('const second = 2') as string] })
  })

  test('with sharing off, nothing is written or pushed', async () => {
    const { repo, blame } = await setup()
    await commitAll(repo, 'second constant')
    const remote = await withRemote(repo)
    await pushWithNotes(blame, repo)
    expect(await readNote(repo, await headSha(repo))).toEqual([])
    const remoteRefs = await simpleGit({ baseDir: remote }).raw(['for-each-ref', PROMPT_NOTES_REF])
    expect(remoteRefs.trim()).toBe('')
  })

  test("publishing merges the remote's notes instead of overwriting them", async () => {
    const { repo, blame } = await setup(new Set(['s1']), true)
    await commitAll(repo, 'second constant')
    const remote = await withRemote(repo)
    await pushWithNotes(blame, repo)

    const mate = await teammateClone(remote)
    await agentEdit(
      mate.blame,
      mate.clone,
      () => writeFile(join(mate.clone, 'app.ts'), 'const first = 1\nconst second = 2\nconst third = 3\n'),
      'add a third constant'
    )
    await commitAll(mate.clone, 'third constant')
    expect(await pushWithNotes(mate.blame, mate.clone)).toEqual([])

    await simpleGit({ baseDir: repo }).raw(['pull', '--ff-only'])
    await writeFile(join(repo, 'notes.md'), 'a person wrote this\n')
    await commitAll(repo, 'notes')
    expect(await pushWithNotes(blame, repo)).toEqual([])

    const notes = await simpleGit({ baseDir: remote }).raw(['notes', `--ref=${PROMPT_NOTES_REF}`, 'list'])
    expect(notes.trim().split('\n')).toHaveLength(2)
  })

  test('narrowing keeps one record per writer with the keys it wrote', () => {
    const record = { sessionId: 's1', files: { 'a.ts': ['k1', 'k2', 'k3'] } } as unknown as StoredAttribution
    const narrowed = narrowedRecords([
      { record, path: 'a.ts', key: 'k2' },
      { record, path: 'a.ts', key: 'k1' }
    ])
    expect(narrowed).toHaveLength(1)
    expect(narrowed[0].files).toEqual({ 'a.ts': ['k1', 'k2'] })
  })

  test('problems follow the git summary on their own lines', () => {
    expect(withProblems('pushed', ['', ''])).toBe('pushed')
    expect(withProblems('pushed', ['Prompt notes not shared: denied'])).toBe(
      'pushed\nPrompt notes not shared: denied'
    )
  })
})

describe('parsing', () => {
  test('added lines by file, skipping deleted files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +2,2 @@',
      '+one',
      '+two',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-removed'
    ].join('\n')
    expect([...addedLinesByFile(diff)]).toEqual([['a.ts', ['one', 'two']]])
  })

  test('lines too common to attribute have no key', () => {
    expect(lineKey('  }  ')).toBeNull()
    expect(lineKey('*/')).toBeNull()
    expect(lineKey('----')).toBeNull()
    expect(lineKey('  return value')).toBe(lineKey('return value'))
  })

  test('a blame for an uncommitted line, or a line that no longer matches, has no commit', () => {
    const zero = '0000000000000000000000000000000000000000 2 2 1\nauthor Not Committed Yet\n\tx'
    expect(parseBlamePorcelain(zero, 'x')).toBeNull()
    const committed = 'abc123 2 2 1\nauthor Person\nauthor-time 100\nsummary init\n\tconst a = 1'
    expect(parseBlamePorcelain(committed, 'const a = 1')).toEqual({
      sha: 'abc123',
      author: 'Person',
      time: 100000,
      summary: 'init'
    })
    expect(parseBlamePorcelain(committed, 'const a = 2')).toBeNull()
  })
})

describe('how a blamed line reads', () => {
  const prompt = {
    sessionId: 's1',
    sessionTitle: 'Constants',
    harness: 'claude',
    turnSeq: 4,
    stepIndex: 1,
    from: 'You',
    prompt: 'add a second constant\nand explain it',
    at: '2026-01-01T00:00:00Z',
    sessionExists: true
  }

  test('a line no prompt wrote shows nothing', () => {
    expect(blameLabel({ commit: null, prompt: null })).toBeNull()
  })

  test('the prompt sits beside the commit, or says the line is uncommitted', () => {
    const now = Date.parse('2026-01-01T05:00:00Z')
    const commit = { sha: 'abc', author: 'Ada', time: Date.parse('2026-01-01T02:00:00Z'), summary: 'consts' }
    expect(blameLabel({ commit, prompt }, now)).toBe(
      '✦ “add a second constant”  ·  Ada, 3h ago · consts'
    )
    expect(blameLabel({ commit: null, prompt }, now)).toBe(
      '✦ “add a second constant”  ·  uncommitted'
    )
  })

  test('a long prompt is cut to fit', () => {
    expect(promptHeadline('x'.repeat(80), 10)).toBe('xxxxxxxxx…')
  })
})

describe('revealing a turn', () => {
  test('a seq falls in the last section starting at or before it', () => {
    const sections = [
      { key: 'lead', startSeq: null },
      { key: 'a', startSeq: 3 },
      { key: 'b', startSeq: 9 }
    ]
    expect(sectionHolding(sections, 3)).toBe('a')
    expect(sectionHolding(sections, 8)).toBe('a')
    expect(sectionHolding(sections, 12)).toBe('b')
    expect(sectionHolding(sections, 1)).toBeNull()
  })
})
