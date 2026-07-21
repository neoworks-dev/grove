import { describe, it, expect } from 'bun:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentManager, type AgentEvents } from '../src/main/agents'
import type { AgentAdapter, AdapterContext } from '../src/main/agents/types'
import type { AgentLaunchOptions, Worktree } from '../src/shared/types'

function makeWorktree(path: string): Worktree {
  return {
    id: 'wt1',
    name: 'wt1',
    path,
    branch: 'main',
    isMain: true,
    isDetached: false,
    locked: false,
    dirty: false,
    portSlot: 0
  }
}

function noopEvents(): AgentEvents {
  return {
    onStatus: () => {},
    onLog: () => {},
    onPermission: () => {}
  }
}

// Fake adapter that records each launch's options and exits immediately.
function makeAdapter(seen: AgentLaunchOptions[]): AgentAdapter {
  return {
    name: 'claude',
    config: { command: 'claude' },
    start: (context: AdapterContext) => {
      seen.push({ ...context.options })
      queueMicrotask(() => context.setStatus('exited', 0))
      return { stop: async () => {} }
    }
  }
}

describe('AgentManager session-scoped launch options', () => {
  it('keeps appendSystemPrompt/intro sticky across restarts that omit them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-'))
    const worktree = makeWorktree(dir)
    const seen: AgentLaunchOptions[] = []
    const adapters = new Map([['claude', makeAdapter(seen)]])
    const manager = new AgentManager(noopEvents(), adapters)
    const chat = manager.createInstance(worktree.id, 'claude', 'Onboarding')

    await manager.start(
      worktree,
      'claude',
      { command: 'claude' },
      [],
      { prompt: 'kickoff', mode: 'acceptEdits', appendSystemPrompt: 'PROTOCOL', intro: true },
      true,
      chat.id
    )
    // A later start without the session-scoped fields (e.g. the composer
    // restarting an idle chat) must not drop them.
    await manager.start(
      worktree,
      'claude',
      { command: 'claude' },
      [],
      { prompt: 'follow-up', mode: 'default' },
      true,
      chat.id
    )

    expect(seen).toHaveLength(2)
    expect(seen[1].appendSystemPrompt).toBe('PROTOCOL')
    expect(seen[1].intro).toBe(true)
    expect(seen[1].prompt).toBe('follow-up')
    expect(seen[1].mode).toBe('default')
  })

  it('does not leak sticky options into other chat instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-'))
    const worktree = makeWorktree(dir)
    const seen: AgentLaunchOptions[] = []
    const adapters = new Map([['claude', makeAdapter(seen)]])
    const manager = new AgentManager(noopEvents(), adapters)
    const onboarding = manager.createInstance(worktree.id, 'claude', 'Onboarding')
    const regular = manager.createInstance(worktree.id, 'claude', 'Regular')

    await manager.start(
      worktree,
      'claude',
      { command: 'claude' },
      [],
      { prompt: 'kickoff', appendSystemPrompt: 'PROTOCOL', intro: true },
      true,
      onboarding.id
    )
    await manager.start(
      worktree,
      'claude',
      { command: 'claude' },
      [],
      { prompt: 'hello' },
      true,
      regular.id
    )

    expect(seen).toHaveLength(2)
    expect(seen[1].appendSystemPrompt).toBeUndefined()
    expect(seen[1].intro).toBeUndefined()
  })
})
