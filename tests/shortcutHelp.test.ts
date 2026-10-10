// What the agent pane's shortcut help lists: the pane's own bindings with the keys
// they answer to now, and none of another pane's.

import { describe, expect, test } from 'bun:test'
import { parseSequence } from '../src/renderer/src/lib/keySequence'
import { paneShortcutRows } from '../src/renderer/src/lib/agents/shortcutHelp'
import type { ResolvedBinding } from '../src/renderer/src/lib/keymap.svelte'

/** A binding as the keymap resolves it. */
function binding(id: string, keys: string, context: string, mode?: string): ResolvedBinding {
  const sequence = parseSequence(keys)
  if (!sequence) throw new Error(`bad keys ${keys}`)
  return { id, keys, context, mode, description: `does ${id}`, sequence, run: () => {} }
}

describe('paneShortcutRows', () => {
  test('lists the pane own bindings under the keys they hold now', () => {
    const rows = paneShortcutRows(
      [
        binding('agent.toggleNotes:leaf-5', 'ctrl+y', 'leaf-5'),
        binding('other', 'ctrl+k', 'leaf-9')
      ],
      'leaf-5'
    )
    expect(rows).toEqual([{ keys: 'Ctrl+y', description: 'does agent.toggleNotes:leaf-5' }])
  })

  test('says when a key only works outside the prompt', () => {
    const rows = paneShortcutRows(
      [binding('agent.scrollDown:leaf-5', 'j', 'leaf-5', 'normal')],
      'leaf-5'
    )
    expect(rows[0].description).toContain('prompt is not focused')
  })
})
