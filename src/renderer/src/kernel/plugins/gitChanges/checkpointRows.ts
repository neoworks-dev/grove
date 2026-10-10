// What the git pane's Checkpoints section lists: the safety snapshots Grove
// takes before it rewrites a worktree, newest first, with a plain label for
// what triggered each.

import type { CheckpointMeta, CheckpointTrigger } from '../../../../../shared/types'

/**
 * Snapshots taken for the agent pane's rewind menu, one per prompt. They have
 * their own place to be restored from, so they stay out of this list.
 */
export const HIDDEN_TRIGGERS: readonly CheckpointTrigger[] = ['user-message']

const TRIGGER_LABELS: Record<CheckpointTrigger, string> = {
  'agent-turn-end': 'After agent turn',
  'user-message': 'Before prompt',
  'pre-restore': 'Before restore',
  'pre-merge': 'Before merge',
  'pre-rebase': 'Before rebase',
  'pre-reset': 'Before reset',
  manual: 'Manual snapshot',
  'review-baseline': 'Before agent edits'
}

/** What triggered the snapshot, in words for a row. */
export function triggerLabel(trigger: CheckpointTrigger): string {
  return TRIGGER_LABELS[trigger]
}

/** The snapshots worth listing, newest first. */
export function visibleCheckpoints(checkpoints: CheckpointMeta[]): CheckpointMeta[] {
  const visible = checkpoints.filter((checkpoint) => !HIDDEN_TRIGGERS.includes(checkpoint.trigger))
  return visible.sort((first, second) => second.ts - first.ts)
}
