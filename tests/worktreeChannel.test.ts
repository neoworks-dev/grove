import { describe, it, expect } from 'bun:test'
import { WorktreeChannel } from '../src/main/agents/channel'
import type { WorktreeChatMessage } from '../src/shared/types'

describe('WorktreeChannel', () => {
  it('stores messages per worktree and notifies once each', () => {
    const seen: WorktreeChatMessage[] = []
    const channel = new WorktreeChannel({ onMessage: (message) => seen.push(message) })

    channel.post('wt1', { kind: 'user', name: 'you' }, 'hello')
    channel.post('wt1', { kind: 'agent', name: 'claude' }, 'hi', 'you')
    channel.post('wt2', { kind: 'user', name: 'you' }, 'other worktree')

    expect(seen).toHaveLength(3)
    expect(channel.list('wt1').map((m) => m.text)).toEqual(['hello', 'hi'])
    expect(channel.list('wt2')).toHaveLength(1)
    expect(channel.list('wt1')[1].to).toBe('you')
  })

  it('filters history by timestamp', () => {
    let clock = 100
    const channel = new WorktreeChannel({ onMessage: () => {} }, () => clock)
    channel.post('wt1', { kind: 'user', name: 'you' }, 'first')
    clock = 200
    channel.post('wt1', { kind: 'user', name: 'you' }, 'second')

    expect(channel.list('wt1', 150).map((m) => m.text)).toEqual(['second'])
    expect(channel.list('wt1', 0)).toHaveLength(2)
  })
})
