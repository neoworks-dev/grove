// Ctrl+T shows or hides the agent's to-do list. The binding lives in a Svelte
// component next to the pane's other bindings, so this reads the source rather
// than mounting it: the key must be bound exactly once in the renderer, to the
// toggle, and the list must take its open state from the pane.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const PANE = 'src/renderer/src/kernel/plugins/agents/agent/AgentPane.svelte'
const NOTES = 'src/renderer/src/kernel/plugins/agents/agent/AgentNotes.svelte'

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path))
      continue
    }
    found.push(path)
  }
  return found
}

describe('Ctrl+T in the agent pane', () => {
  test('is bound to the to-do list toggle in the pane', () => {
    const source = readFileSync(PANE, 'utf8')
    expect(source).toMatch(/keys:\s*'ctrl\+t',[\s\S]*?run:\s*toggleNotes/)
  })

  test('is not bound anywhere else in the renderer', () => {
    const offenders = filesUnder('src/renderer/src')
      .filter((path) => /\.(svelte|ts)$/.test(path))
      .filter((path) => path !== PANE)
      .filter((path) => /keys:\s*'ctrl\+t'/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('the to-do list takes its open state from the pane', () => {
    const source = readFileSync(NOTES, 'utf8')
    expect(source).toContain('open = $bindable(true)')
    expect(readFileSync(PANE, 'utf8')).toContain('bind:open={notesOpen}')
  })
})
