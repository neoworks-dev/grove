// Permission modes, rebuilt on top of what nib actually has.
//
// nib has no notion of a mode: it has per-tool policies, a session-scoped
// auto-approve list, and an active-tool allow-list. Those are enough to express
// the three modes that matter, and deriving the mode from them rather than storing
// it separately means it survives a restart and cannot drift out of step with the
// session it describes.
//
//   plan         the mutating tools are not offered at all
//   accept edits write and edit are auto-approved for the session
//   bypass       every approval is answered for you
//
// Only bypass has no server-side representation, which is the right way round:
// "do whatever you like" should not quietly outlive the sitting it was granted in.

import type { ConfirmationResult, SessionSnapshot } from './types'

export type AgentMode = 'default' | 'plan' | 'acceptEdits' | 'bypass'

// The tools that change something. Plan mode withholds them; accept-edits
// pre-approves the two that write files, but never bash.
export const WRITE_TOOLS = ['write', 'edit']
export const MUTATING_TOOLS = [...WRITE_TOOLS, 'bash']

export const MODE_LABELS: Record<AgentMode, string> = {
  default: 'ask',
  plan: 'plan',
  acceptEdits: 'accept edits',
  bypass: 'bypass'
}

/**
 * Which mode a session is in. `bypassing` is the caller's own volatile flag; the
 * rest is read back off the session, so a session opened in a new window reports
 * the mode it is actually in.
 */
export function modeOf(snapshot: SessionSnapshot | null, bypassing: boolean): AgentMode {
  if (bypassing) return 'bypass'
  if (!snapshot) return 'default'
  if (isPlanning(snapshot)) return 'plan'
  if (WRITE_TOOLS.every((tool) => snapshot.autoApproveTools.includes(tool))) return 'acceptEdits'
  return 'default'
}

function isPlanning(snapshot: SessionSnapshot): boolean {
  if (snapshot.activeTools === null) return false
  return MUTATING_TOOLS.every((tool) => !snapshot.activeTools!.includes(tool))
}

/**
 * The `activeTools` to PATCH when switching into a mode. `null` restores the full
 * set, which is nib's own way of saying "no allow-list".
 */
export function activeToolsFor(mode: AgentMode, allTools: string[]): string[] | null {
  if (mode !== 'plan') return null
  return allTools.filter((tool) => !MUTATING_TOOLS.includes(tool))
}

/**
 * How to answer an approval without asking, or null to put it to the user.
 *
 * Accept-edits stands down while changes are reviewed before they are written:
 * holding each edit at the prompt is the entire point of that setting, and
 * auto-approving would skip the review it exists to raise.
 */
export function autoDecisionFor(
  mode: AgentMode,
  toolName: string,
  reviewMode: string
): ConfirmationResult | null {
  if (mode === 'bypass') return 'allow'
  if (mode !== 'acceptEdits') return null
  if (reviewMode === 'pre') return null
  if (!WRITE_TOOLS.includes(toolName)) return null
  return 'always_session'
}
