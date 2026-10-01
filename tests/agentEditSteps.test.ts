// Recording what each of an agent's tool calls did to the worktree, and folding
// those steps into the turns a session replay walks.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import {
  CheckpointManager,
  captureTree,
  diffTrees,
  pinTreePair,
  unpinTrees
} from '../src/main/checkpoints'
import { EditStepRecorder, replayTurns, stepsRef } from '../src/main/agents/editSteps'
import { SessionStore } from '../src/main/agents/store'
import type { AgentEditStep, EventBody, SessionEvent } from '../src/shared/agents'

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
  const dir = await scratchDir('grove-steps-repo-')
  const git = simpleGit({ baseDir: dir })
  await git.init()
  await git.addConfig('user.email', 'test@grove.local')
  await git.addConfig('user.name', 'Test')
  await git.addConfig('commit.gpgsign', 'false')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', 'init'])
  return dir
}

/** A recorder on a real repository and a real store, with what it published. */
async function setup(): Promise<{
  repo: string
  store: SessionStore
  recorder: EditStepRecorder
  sessionId: string
  published: AgentEditStep[]
}> {
  const repo = await scratchRepo()
  const store = new SessionStore(await scratchDir('grove-steps-store-'))
  const session = await store.create({
    workspaceRoot: repo,
    harness: 'test',
    title: 'Test',
    provider: 'test',
    model: 'test',
    thinkingLevel: 'off',
    activeTools: null
  })
  const published: AgentEditStep[] = []
  const recorder = new EditStepRecorder({
    store,
    trees: {
      capture: captureTree,
      pin: (root, sessionId, before, after) => pinTreePair(root, stepsRef(sessionId), before, after),
      unpin: (root, sessionId) => unpinTrees(root, stepsRef(sessionId)),
      diff: diffTrees
    },
    publish: (_sessionId, step) => published.push(step)
  })
  recorder.watch()
  return { repo, store, recorder, sessionId: session.id, published }
}

function toolCall(toolCallId: string, kind: string, title: string): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId, kind, title, status: 'pending' }
  } as EventBody
}

function settled(toolCallId: string): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }
  } as EventBody
}

function userMessage(text: string): EventBody {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

/** Waits until the recorder has published `count` steps. */
async function stepsPublished(published: AgentEditStep[], count: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (published.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('recording edit steps', () => {
  test('a call that changed a file is a step with the trees either side', async () => {
    const { repo, store, sessionId, published } = await setup()
    await store.append(sessionId, userMessage('add a third line'))
    await store.append(sessionId, toolCall('call-1', 'edit', 'Edit a.txt'))
    // Let the "before" capture land before the file changes, as a real tool would.
    await new Promise((resolve) => setTimeout(resolve, 150))
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    await store.append(sessionId, settled('call-1'))
    await stepsPublished(published, 1)

    expect(published).toHaveLength(1)
    const step = published[0]
    expect(step.index).toBe(1)
    expect(step.turnSeq).toBe(1)
    expect(step.title).toBe('Edit a.txt')
    expect(step.files).toEqual([{ path: 'a.txt', status: 'modified', added: 1, removed: 0 }])

    const git = simpleGit({ baseDir: repo })
    expect(await git.raw(['show', `${step.before}:a.txt`])).toBe('one\ntwo\n')
    expect(await git.raw(['show', `${step.after}:a.txt`])).toBe('one\ntwo\nthree\n')
  })

  test('the trees are pinned under the session ref', async () => {
    const { repo, store, sessionId, published } = await setup()
    await store.append(sessionId, toolCall('call-1', 'edit', 'Write b.txt'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    await writeFile(join(repo, 'b.txt'), 'new\n')
    await store.append(sessionId, settled('call-1'))
    await stepsPublished(published, 1)

    const git = simpleGit({ baseDir: repo })
    const pinnedTree = (await git.raw(['rev-parse', `${stepsRef(sessionId)}^{tree}`])).trim()
    expect(pinnedTree).toBe(published[0].after)
    expect(published[0].files[0]).toMatchObject({ path: 'b.txt', status: 'added' })
  })

  test('a read-only call, or one that changed nothing, is not a step', async () => {
    const { repo, store, sessionId, recorder, published } = await setup()
    await store.append(sessionId, toolCall('read-1', 'read', 'Read a.txt'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    await writeFile(join(repo, 'a.txt'), 'changed by someone else\n')
    await store.append(sessionId, settled('read-1'))
    await store.append(sessionId, toolCall('edit-1', 'edit', 'Edit a.txt'))
    await store.append(sessionId, settled('edit-1'))
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(published).toHaveLength(0)
    expect(await recorder.stepsOf(sessionId)).toEqual([])
  })

  test('steps survive a restart, read back from the session directory', async () => {
    const { repo, store, sessionId, published } = await setup()
    await store.append(sessionId, toolCall('call-1', 'execute', 'Run a script'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    await writeFile(join(repo, 'a.txt'), 'rewritten\n')
    await store.append(sessionId, settled('call-1'))
    await stepsPublished(published, 1)

    const saved = JSON.parse(await readFile(join(store.dirOf(sessionId), 'steps.json'), 'utf8'))
    expect(saved).toHaveLength(1)
    const fresh = new EditStepRecorder({
      store,
      trees: {
        capture: captureTree,
        pin: async () => {},
        unpin: async () => {},
        diff: diffTrees
      },
      publish: () => {}
    })
    expect((await fresh.stepsOf(sessionId))[0].after).toBe(published[0].after)
  })
})

describe('rolling back to a step', () => {
  test('restoreTree puts the worktree back as the step left it, checkpointing first', async () => {
    const { repo, store, sessionId, published } = await setup()
    await store.append(sessionId, toolCall('call-1', 'edit', 'Edit a.txt'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    await writeFile(join(repo, 'a.txt'), 'step one\n')
    await store.append(sessionId, settled('call-1'))
    await stepsPublished(published, 1)
    await writeFile(join(repo, 'a.txt'), 'later work\n')
    await writeFile(join(repo, 'c.txt'), 'created later\n')

    const checkpoints = new CheckpointManager()
    const result = await checkpoints.restoreTree(repo, published[0].after)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('step one\n')
    expect(result.preRestore?.trigger).toBe('pre-restore')
  })
})

describe('replay turns', () => {
  function event(seq: number, body: EventBody): SessionEvent {
    return { ...body, id: `e${seq}`, seq, sessionId: 's', createdAt: `t${seq}` } as SessionEvent
  }

  function step(index: number, turnSeq: number | null): AgentEditStep {
    return {
      index,
      turnSeq,
      seq: 0,
      toolCallId: `c${index}`,
      title: `step ${index}`,
      kind: 'edit',
      at: `s${index}`,
      before: `b${index}`,
      after: `a${index}`,
      files: []
    }
  }

  test('each message starts a turn holding the steps made while it ran', () => {
    const events = [
      event(1, userMessage('first')),
      event(2, { type: 'session.status_running' }),
      event(5, { type: 'app.message', label: 'Review feedback', text: 'fix it' }),
      event(8, userMessage('third'))
    ]
    const turns = replayTurns(events, [step(1, 1), step(2, 1), step(3, 5)])
    expect(turns.map((turn) => [turn.seq, turn.from, turn.prompt, turn.steps.length])).toEqual([
      [1, 'You', 'first', 2],
      [5, 'Review feedback', 'fix it', 1],
      [8, 'You', 'third', 0]
    ])
  })

  test('steps with no turn gather at the start', () => {
    const turns = replayTurns([event(3, userMessage('later'))], [step(1, null)])
    expect(turns[0].seq).toBeNull()
    expect(turns[0].steps.map((entry) => entry.index)).toEqual([1])
    expect(turns[1].prompt).toBe('later')
  })
})
