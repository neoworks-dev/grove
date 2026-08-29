// Permission modes, rebuilt on top of what a session actually has.
//
// A session has no notion of a mode: it has per-tool policies, a session-scoped
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
 * The mode a session is already in, read back off its own state — so reopening a
 * session in a new window reports what it is actually doing rather than a
 * default.
 *
 * This is only half the story: accept-edits and bypass are entered by answering
 * approvals, so a freshly chosen one is not visible here until the first call it
 * covers comes through. Callers hold the chosen mode alongside this and let it
 * win, which is what `effectiveMode` does.
 */
export function modeOf(snapshot: SessionSnapshot | null): AgentMode {
  if (!snapshot) return 'default'
  if (isPlanning(snapshot)) return 'plan'
  if (WRITE_TOOLS.every((tool) => snapshot.autoApproveTools.includes(tool))) return 'acceptEdits'
  return 'default'
}

/** The mode in force: what the user last chose, else what the session reports. */
export function effectiveMode(
  chosen: AgentMode | null,
  snapshot: SessionSnapshot | null
): AgentMode {
  if (chosen !== null) return chosen
  return modeOf(snapshot)
}

function isPlanning(snapshot: SessionSnapshot): boolean {
  if (snapshot.activeTools === null) return false
  return MUTATING_TOOLS.every((tool) => !snapshot.activeTools!.includes(tool))
}

/**
 * The `activeTools` to PATCH when switching into a mode. `null` restores the full
 * set, which is how a session says "no allow-list".
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
