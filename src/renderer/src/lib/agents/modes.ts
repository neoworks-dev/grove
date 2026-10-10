// Permission modes, as the picker under the composer presents them.
//
// The mode itself lives on the session in the main process: that is what gates
// tool calls and raises reviews, so a mode the renderer kept to itself would
// not take effect and would not survive reopening the session. Everything here
// is presentation — what to call each mode, what to say it does, and what order
// shift+tab steps through them in.

import type { AgentMode, SessionSnapshot } from './types'

export type { AgentMode }

export const MODE_LABELS: Record<AgentMode, string> = {
  default: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  bypass: 'Bypass'
}

/** What each mode actually lets the agent do, for the picker. */
export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  default: 'Every write and command is put to you first.',
  plan: 'Read and propose only — the tools that change anything are withheld.',
  acceptEdits: 'File edits go through on their own; commands still ask.',
  bypass: 'Nothing is asked. Every call runs, including shell commands.'
}

/** The order the picker lists the modes in, least permissive first. */
export const MODE_ORDER: AgentMode[] = ['default', 'plan', 'acceptEdits', 'bypass']

/**
 * Modes shift+tab never lands on. Plan stays in the picker, but stepping
 * through to bypass should not pass over it by accident.
 */
const MODES_SKIPPED_BY_CYCLE: AgentMode[] = ['plan']

/**
 * The mode shift+tab moves a session to from `current`.
 *
 * Walks the picker order forward, skipping the modes the cycle leaves out, so
 * a session already in plan mode still moves on to the next mode that is cycled.
 */
export function nextMode(current: AgentMode): AgentMode {
  let index = MODE_ORDER.indexOf(current)
  for (let step = 0; step < MODE_ORDER.length; step += 1) {
    index = (index + 1) % MODE_ORDER.length
    if (!MODES_SKIPPED_BY_CYCLE.includes(MODE_ORDER[index])) {
      return MODE_ORDER[index]
    }
  }
  return current
}

/**
 * The mode a session is in, read off the session itself.
 *
 * A session that has not been given one yet reads as `default`, which is also
 * what the main process stores for a session written before modes were kept
 * there.
 */
export function modeOf(snapshot: SessionSnapshot | null): AgentMode {
  if (!snapshot) return 'default'
  return snapshot.permissionMode ?? 'default'
}
