// Reasoning effort, as the controls show it.
//
// The protocol spells the levels in lower case because they go on the wire;
// the status line spells them the way a label reads.

import type { ThinkingLevel } from './types'

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

/** The level after this one, wrapping — what ctrl+tab steps through. */
export function nextThinkingLevel(current: ThinkingLevel): ThinkingLevel {
  const index = THINKING_LEVELS.indexOf(current)
  return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]
}
