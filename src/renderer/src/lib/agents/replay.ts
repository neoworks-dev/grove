// The logic behind the session replay pane: where its scrubber can stop, and
// how a step reads.

import type { AgentEditStep, ReplayTurn, SessionReplay } from '../../../../shared/agents'
import type { TreeFileChange } from '../../../../shared/types'

/**
 * A stop on the scrubber: the worktree before the session's first edit, or as
 * one step left it. `tree` is the state at that stop.
 */
export interface ReplayPosition {
  /** 0 for the start, else the step's index. */
  index: number
  step: AgentEditStep | null
  tree: string
  turn: ReplayTurn | null
}

/** Every stop on the scrubber, start first. Empty when the session made no edits. */
export function positionsOf(replay: SessionReplay): ReplayPosition[] {
  const steps: { step: AgentEditStep; turn: ReplayTurn }[] = []
  for (const turn of replay.turns) {
    for (const step of turn.steps) steps.push({ step, turn })
  }
  if (steps.length === 0) return []
  steps.sort((left, right) => left.step.index - right.step.index)

  const start: ReplayPosition = { index: 0, step: null, tree: steps[0].step.before, turn: null }
  const rest = steps.map(({ step, turn }) => ({ index: step.index, step, tree: step.after, turn }))
  return [start, ...rest]
}

/** What a step did, in a few words: the call's title, else its kind. */
export function stepTitle(step: AgentEditStep): string {
  const title = step.title.trim()
  if (title.length > 0) return title
  return step.kind
}

/** The lines a set of files gained and lost; binary files count for nothing. */
export function lineTotals(files: readonly TreeFileChange[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const file of files) {
    if (file.added > 0) added += file.added
    if (file.removed > 0) removed += file.removed
  }
  return { added, removed }
}

/** A prompt cut down to its first line, for a timeline row. */
export function promptHeadline(prompt: string, limit = 120): string {
  const firstLine = prompt.trim().split('\n')[0]
  if (firstLine.length <= limit) return firstLine
  return `${firstLine.slice(0, limit - 1)}…`
}

/** "1 file", "3 files". */
export function filesLabel(count: number): string {
  if (count === 1) return '1 file'
  return `${count} files`
}
