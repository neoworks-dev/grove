/**
 * What a compaction row says. The row follows one compaction through: working
 * while the harness shrinks the conversation, then what came of it. The token
 * counts are the point of a finished one: they say how much room it made.
 */

import type { CompactionItem } from './transcript'

/** The row's one line: what the compaction is doing, or what it came to. */
export function compactionLabel(item: CompactionItem): string {
  if (item.status === 'running') {
    if (item.trigger === 'automatic') return 'Compacting context, which was nearly full…'
    return 'Compacting context…'
  }
  if (item.status === 'failed') {
    if (item.error) return `Compaction failed: ${item.error}`
    return 'Compaction failed.'
  }
  if (item.status === 'cancelled') {
    return 'Compaction cancelled.'
  }
  return `Context compacted${triggerSuffix(item)}${tokensSuffix(item)}`
}

function triggerSuffix(item: CompactionItem): string {
  if (item.trigger === 'automatic') return ' automatically'
  return ''
}

/** " · 26.7k → 3.2k tokens", or nothing when the harness did not say. */
function tokensSuffix(item: CompactionItem): string {
  if (item.tokensBefore === null) return ''
  if (item.tokensAfter === null) return ` · from ${thousands(item.tokensBefore)} tokens`
  return ` · ${thousands(item.tokensBefore)} → ${thousands(item.tokensAfter)} tokens`
}

/** Tokens as the working bar counts them: thousands, one decimal. */
function thousands(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`
}
