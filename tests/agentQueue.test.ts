import { describe, it, expect } from 'bun:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentManager, type AgentEvents } from '../src/main/agents'
import type { AgentAdapter, AdapterContext } from '../src/main/agents/types'
import type { AgentQueueEvent, Worktree } from '../src/shared/types'

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

function noopEvents(overrides: Partial<AgentEvents> = {}): AgentEvents {
  return {
    onStatus: () => {},
    onLog: () => {},
    onPermission: () => {},
    ...overrides
  }
}

// Controllable fake adapter: records started prompts, lets the test decide
// whether live sends are accepted, and exposes the context to end the run.
interface FakeRun {
  context: AdapterContext
  sent: string[]
}

function makeFakeAdapter(options: { acceptSends: boolean }): {
  adapter: AgentAdapter
  runs: FakeRun[]
} {
  const runs: FakeRun[] = []
  const adapter: AgentAdapter = {
    name: 'fake',
    config: { command: 'fake' },
    start: (context) => {
      const run: FakeRun = { context, sent: [] }
      runs.push(run)
      return {
        send: (text) => {
          if (!options.acceptSends) return false
          run.sent.push(text)
          return true
        },
        stop: async () => context.setStatus('stopped')
      }
    }
  }
  return { adapter, runs }
}

function makeManager(
  adapter: AgentAdapter,
  overrides: Partial<AgentEvents> = {}
): AgentManager {
  return new AgentManager(noopEvents(overrides), new Map([['fake', adapter]]))
}

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wt-'))
}

describe('AgentManager mid-run send + queue', () => {
  it('injects into a live run that accepts sends and echoes the prompt', async () => {
    const dir = await makeDir()
    const { adapter, runs } = makeFakeAdapter({ acceptSends: true })
    const logged: string[] = []
    const manager = makeManager(adapter, {
      onLog: (_wt, _name, _chatId, line) => logged.push(line)
    })
    const worktree = makeWorktree(dir)

    await manager.start(worktree, 'fake', adapter.config, [], { prompt: 'first' })
    const result = await manager.send(worktree, 'fake', adapter.config, [], 'steer left')

    expect(result).toEqual({ delivered: 'injected' })
    expect(runs[0].sent).toEqual(['steer left'])
    expect(logged.some((line) => line.includes('steer left'))).toBe(true)
    expect(manager.getQueue('wt1', 'fake')).toHaveLength(0)
  })

  it('queues when the run rejects sends and auto-submits on clean exit', async () => {
    const dir = await makeDir()
    const { adapter, runs } = makeFakeAdapter({ acceptSends: false })
    const queueEvents: AgentQueueEvent[] = []
    const manager = makeManager(adapter, {
      onQueue: (event) => queueEvents.push(event)
    })
    const worktree = makeWorktree(dir)

    await manager.start(worktree, 'fake', adapter.config, [], { prompt: 'first' })
    const one = await manager.send(worktree, 'fake', adapter.config, [], 'queued one')
    const two = await manager.send(worktree, 'fake', adapter.config, [], 'queued two')

    expect(one.delivered).toBe('queued')
    expect(two.delivered).toBe('queued')
    expect(manager.getQueue('wt1', 'fake').map((item) => item.text)).toEqual([
      'queued one',
      'queued two'
    ])

    runs[0].context.setStatus('exited', 0)
    // The follow-up start is fired asynchronously from the terminal handler.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(manager.getQueue('wt1', 'fake')).toHaveLength(0)
    expect(runs).toHaveLength(2)
    expect(runs[1].context.options.prompt).toBe('queued one\n\nqueued two')
    expect(queueEvents.at(-1)?.queue).toHaveLength(0)
  })

  it('cancelQueued removes a single message', async () => {
    const dir = await makeDir()
    const { adapter } = makeFakeAdapter({ acceptSends: false })
    const manager = makeManager(adapter)
    const worktree = makeWorktree(dir)

    await manager.start(worktree, 'fake', adapter.config, [], { prompt: 'first' })
    const queued = await manager.send(worktree, 'fake', adapter.config, [], 'to cancel')
    if (queued.delivered !== 'queued') throw new Error('expected queued')

    const chatId = manager.listChats('wt1', 'fake').activeId
    manager.cancelQueued('wt1', 'fake', chatId, queued.id)
    expect(manager.getQueue('wt1', 'fake')).toHaveLength(0)
  })

  it('a user stop flushes the queue back instead of auto-submitting', async () => {
    const dir = await makeDir()
    const { adapter, runs } = makeFakeAdapter({ acceptSends: false })
    const queueEvents: AgentQueueEvent[] = []
    const manager = makeManager(adapter, {
      onQueue: (event) => queueEvents.push(event)
    })
    const worktree = makeWorktree(dir)

    await manager.start(worktree, 'fake', adapter.config, [], { prompt: 'first' })
    await manager.send(worktree, 'fake', adapter.config, [], 'never run me')

    const chatId = manager.listChats('wt1', 'fake').activeId
    await manager.stop('wt1', 'fake', chatId, { clearQueue: true })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(manager.getQueue('wt1', 'fake')).toHaveLength(0)
    expect(runs).toHaveLength(1) // no auto-started follow-up run
    const cleared = queueEvents.find((event) => event.cleared)
    expect(cleared?.cleared?.map((item) => item.text)).toEqual(['never run me'])
  })

  it('ignores a late terminal status from a replaced run', async () => {
    const dir = await makeDir()
    const { adapter, runs } = makeFakeAdapter({ acceptSends: true })
    const manager = makeManager(adapter)
    const worktree = makeWorktree(dir)

    await manager.start(worktree, 'fake', adapter.config, [], { prompt: 'first' })
    await manager.start(worktree, 'fake', adapter.config, [], { prompt: 'second' })

    // The replaced run reports its (late) terminal status.
    runs[0].context.setStatus('stopped')

    expect(manager.isRunning('wt1', 'fake')).toBe(true)
    expect(manager.getRuntime('wt1', 'fake')?.status).toBe('running')
  })
})
