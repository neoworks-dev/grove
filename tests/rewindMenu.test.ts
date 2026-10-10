// The rewind menu: which prompts it lists, what each choice is allowed and sends,
// and the worktree snapshots taken per prompt that a code restore goes back to.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { CheckpointManager, promptSnapshot, promptSnapshotsOf } from '../src/main/checkpoints'
import { captureTree, diffTrees } from '../src/main/checkpoints'
import type { CheckpointMeta } from '../src/shared/types'
import type { SessionEvent } from '../src/shared/agents'
import { applyEvent, createTranscript } from '../src/renderer/src/lib/agents/transcript'
import {
  RESTORE_CODE_WARNING,
  restoresCode,
  restoresConversation,
  rewindAvailability,
  rewindConversationEvents,
  rewindPrompts
} from '../src/renderer/src/lib/agents/rewind'

type Body = Record<string, unknown>

/** A log as the store would stamp it, seq from 1. */
function log(bodies: Body[]): SessionEvent[] {
  return bodies.map(
    (body, index) =>
      ({
        ...body,
        id: `e${index + 1}`,
        seq: index + 1,
        sessionId: 's',
        createdAt: ''
      }) as SessionEvent
  )
}

function say(text: string): Body {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

function reply(text: string, messageId: string): Body {
  return {
    type: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId }
  }
}

const idle: Body = { type: 'session.status_idle', stopReason: 'end_turn' }

describe('which prompts the menu lists', () => {
  test('the prompts of the conversation in play, oldest first, without commands', () => {
    const state = createTranscript()
    for (const event of log([
      say('first'),
      reply('one', 'm1'),
      idle,
      { type: 'user.command', name: 'compact', args: '' },
      say('second'),
      reply('two', 'm2'),
      idle,
      { type: 'user.branch', fromSeq: 3 },
      { type: 'session.branched', fromSeq: 3 },
      say('replacement')
    ])) {
      applyEvent(state, event)
    }
    // "second" was taken back by the branch: it is on the log, not in the conversation.
    expect(rewindPrompts(state).map((prompt) => prompt.text)).toEqual(['first', 'replacement'])
  })

  test('a message the agent has not taken up is not a place to go back to', () => {
    const state = createTranscript()
    for (const event of log([say('first'), { type: 'session.status_running' }, say('waiting')])) {
      applyEvent(state, event)
    }
    expect(rewindPrompts(state).map((prompt) => prompt.text)).toEqual(['first'])
  })
})

describe('what a choice sends and restores', () => {
  test('the conversation goes back to the event the prompt hung from', () => {
    const state = createTranscript()
    for (const event of log([say('first'), reply('one', 'm1'), idle, say('second'), idle])) {
      applyEvent(state, event)
    }
    const prompts = rewindPrompts(state)
    expect(rewindConversationEvents(state, prompts[1])).toEqual([
      { type: 'user.branch', fromSeq: 3 }
    ])
    expect(rewindConversationEvents(state, prompts[0])).toEqual([
      { type: 'user.branch', fromSeq: 0 }
    ])
  })

  test('each choice says which halves it puts back', () => {
    expect([restoresConversation('both'), restoresCode('both')]).toEqual([true, true])
    expect([restoresConversation('conversation'), restoresCode('conversation')]).toEqual([
      true,
      false
    ])
    expect([restoresConversation('code'), restoresCode('code')]).toEqual([false, true])
  })

  test('the confirmation says plainly that hand-made changes go too', () => {
    expect(RESTORE_CODE_WARNING).toContain('including changes you made yourself')
    expect(RESTORE_CODE_WARNING).toContain('A snapshot is taken first')
  })
})

describe('which choices are open', () => {
  const idleWithChanges = {
    harnessRewinds: true,
    running: false,
    hasSnapshot: true,
    changedFileCount: 2
  }

  test('everything is open on an idle session whose worktree has moved on', () => {
    expect(rewindAvailability(idleWithChanges)).toMatchObject({
      conversation: true,
      code: true,
      both: true
    })
  })

  test('code options need the worktree to differ from the snapshot', () => {
    const open = rewindAvailability({ ...idleWithChanges, changedFileCount: 0 })
    expect(open).toMatchObject({ conversation: true, code: false, both: false })
    expect(open.codeReason).toContain('already matches')
  })

  test('code options need a snapshot', () => {
    const open = rewindAvailability({ ...idleWithChanges, hasSnapshot: false })
    expect(open.code).toBe(false)
    expect(open.conversation).toBe(true)
  })

  test('a harness that cannot rewind keeps the conversation options shut', () => {
    const open = rewindAvailability({ ...idleWithChanges, harnessRewinds: false })
    expect(open).toMatchObject({ conversation: false, code: true, both: false })
  })

  test('a running agent shuts everything', () => {
    expect(rewindAvailability({ ...idleWithChanges, running: true })).toMatchObject({
      conversation: false,
      code: false,
      both: false
    })
  })
})

function meta(overrides: Partial<CheckpointMeta>): CheckpointMeta {
  return { n: 1, commit: 'c', tree: 't', ts: 0, trigger: 'prompt-sent', ...overrides }
}

describe('which snapshot belongs to a prompt', () => {
  const list = [
    meta({ n: 1, tree: 'a', sessionId: 's1', promptSeq: 1 }),
    meta({ n: 2, tree: 'b', sessionId: 's2', promptSeq: 1 }),
    meta({ n: 3, tree: 'c', sessionId: 's1', promptSeq: 4 }),
    meta({ n: 4, tree: 'd', trigger: 'manual', sessionId: 's1', promptSeq: 4 })
  ]

  test('is found by session and prompt', () => {
    expect(promptSnapshot(list, 's1', 4)?.tree).toBe('c')
    expect(promptSnapshot(list, 's2', 1)?.tree).toBe('b')
  })

  test('is missing for a prompt sent before snapshots were taken', () => {
    expect(promptSnapshot(list, 's1', 9)).toBeNull()
  })

  test('only the session own prompt snapshots are listed', () => {
    expect(promptSnapshotsOf(list, 's1').map((entry) => entry.tree)).toEqual(['a', 'c'])
  })
})

describe('worktree snapshots per prompt', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  async function repository(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'grove-rewind-test-'))
    const git = simpleGit({ baseDir: directory })
    await git.init()
    await git.addConfig('user.email', 'test@grove.local')
    await git.addConfig('user.name', 'Test')
    await git.addConfig('commit.gpgsign', 'false')
    await writeFile(join(directory, 'a.txt'), 'original\n')
    await git.raw(['add', '-A'])
    await git.raw(['commit', '-m', 'init'])
    return directory
  }

  test('every prompt gets its own snapshot, even when nothing changed between them', async () => {
    const root = await repository()
    const manager = new CheckpointManager()
    const first = await manager.snapshot(root, 'prompt-sent', { sessionId: 's', promptSeq: 1 })
    const second = await manager.snapshot(root, 'prompt-sent', { sessionId: 's', promptSeq: 4 })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(promptSnapshot(manager.list(root), 's', 4)?.tree).toBe(first?.tree)
  })

  test('restoring a prompt puts back the agent edits and the hand edits alike', async () => {
    const root = await repository()
    const manager = new CheckpointManager()
    await manager.snapshot(root, 'prompt-sent', { sessionId: 's', promptSeq: 1 })

    await writeFile(join(root, 'a.txt'), 'agent edit\n')
    await writeFile(join(root, 'by-hand.txt'), 'typed by me\n')
    const snapshot = promptSnapshot(manager.list(root), 's', 1)
    if (!snapshot) throw new Error('no snapshot')

    // What the menu lists before touching anything.
    const changes = await diffTrees(root, await captureTree(root), snapshot.tree)
    expect(changes.map((change) => change.path).sort()).toEqual(['a.txt', 'by-hand.txt'])

    const { preRestore } = await manager.restoreTree(root, snapshot.tree)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('original\n')
    await expect(readFile(join(root, 'by-hand.txt'), 'utf8')).rejects.toThrow()
    // The safety snapshot holds what was thrown away.
    expect(preRestore?.trigger).toBe('pre-restore')
  })

  test('a worktree that already matches the snapshot has nothing to restore', async () => {
    const root = await repository()
    const manager = new CheckpointManager()
    await manager.snapshot(root, 'prompt-sent', { sessionId: 's', promptSeq: 1 })
    const snapshot = promptSnapshot(manager.list(root), 's', 1)
    if (!snapshot) throw new Error('no snapshot')
    expect(await diffTrees(root, await captureTree(root), snapshot.tree)).toEqual([])
  })
})
