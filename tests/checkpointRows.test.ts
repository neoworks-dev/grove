import { describe, it, expect } from 'bun:test'
import {
  HIDDEN_TRIGGERS,
  triggerLabel,
  visibleCheckpoints
} from '../src/renderer/src/kernel/plugins/gitChanges/checkpointRows'
import type { CheckpointMeta, CheckpointTrigger } from '../src/shared/types'

/** A snapshot with only the fields the list reads filled in. */
function snapshot(n: number, trigger: CheckpointTrigger, ts: number): CheckpointMeta {
  return { n, commit: `commit-${n}`, tree: `tree-${n}`, ts, trigger }
}

describe('git pane checkpoints list', () => {
  it('names what triggered each safety snapshot', () => {
    expect(triggerLabel('pre-merge')).toBe('Before merge')
    expect(triggerLabel('pre-rebase')).toBe('Before rebase')
    expect(triggerLabel('pre-reset')).toBe('Before reset')
    expect(triggerLabel('pre-restore')).toBe('Before restore')
  })

  it('hides the per-prompt snapshots the agent pane owns', () => {
    const listed = visibleCheckpoints([
      snapshot(1, 'pre-merge', 100),
      snapshot(2, 'user-message', 200),
      snapshot(3, 'pre-reset', 300)
    ])
    expect(listed.map((checkpoint) => checkpoint.n)).toEqual([3, 1])
    expect(HIDDEN_TRIGGERS).toContain('user-message')
    expect(HIDDEN_TRIGGERS).toContain('prompt-sent')
  })

  it('lists newest first and leaves the input alone', () => {
    const input = [snapshot(1, 'manual', 100), snapshot(2, 'manual', 300)]
    expect(visibleCheckpoints(input).map((checkpoint) => checkpoint.n)).toEqual([2, 1])
    expect(input.map((checkpoint) => checkpoint.n)).toEqual([1, 2])
  })
})
