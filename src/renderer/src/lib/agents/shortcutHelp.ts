/**
 * What the agent pane's shortcut help lists: the pane's bindings as the keymap has
 * them now, so a key the user rebound shows the key it answers to today, followed by
 * the composer's own keys, which are fixed.
 */

import { stepLabel } from '../keySequence'
import type { ResolvedBinding } from '../keymap.svelte'

export interface ShortcutRow {
  keys: string
  description: string
}

/** The composer's own keys, which no binding can change. */
export const COMPOSER_SHORTCUTS: ShortcutRow[] = [
  { keys: 'Enter', description: 'Send the message' },
  { keys: '⇧Enter', description: 'New line' },
  { keys: '↑ ↓', description: 'Step through earlier prompts' },
  { keys: '←', description: 'Session overview, from an empty prompt' },
  { keys: 'Esc', description: 'Stop the agent while it works' },
  { keys: '/', description: 'Run a command' },
  { keys: '@', description: 'Mention a file or an agent' },
  { keys: '!', description: 'Run a shell command' },
  { keys: '?', description: 'Show or hide this help, from an empty prompt' }
]

/** A binding's keys the way a keycap shows them: its steps joined by a space. */
function keysOf(binding: ResolvedBinding): string {
  const steps = binding.sequence.steps.map(stepLabel)
  if (binding.sequence.leader) steps.unshift('␣')
  return steps.join(' ')
}

/** What a binding does, with a note when it only works outside the prompt. */
function descriptionOf(binding: ResolvedBinding): string {
  if (binding.mode === 'normal') return `${binding.description} (when the prompt is not focused)`
  return binding.description
}

/** One row per binding that belongs to the pane, in registration order. */
export function paneShortcutRows(bindings: ResolvedBinding[], leafId: string): ShortcutRow[] {
  const rows: ShortcutRow[] = []
  for (const binding of bindings) {
    if (binding.context !== leafId) continue
    rows.push({ keys: keysOf(binding), description: descriptionOf(binding) })
  }
  return rows
}
