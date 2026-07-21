// Live registry of embedded-Neovim editor sessions, keyed by layout leaf id.
// Lets cross-cutting features (inline agent edit, accept/reject overlay) reach
// the session that owns the focused editor without threading it through props.
// Diff panes build their own sessions but do not register here — only real
// editor panes (NvimPane) do, so `active()` always resolves an editable buffer.

import { keymap } from '../keymap.svelte'
import type { NvimCanvasSession } from './session'

const sessions = new Map<string, NvimCanvasSession>()

// Last leaf whose editor the user was actually in, so features that only need
// "some editor" can prefer the one most recently focused.
let lastEditorLeafId: string | null = null

export function registerNvimSession(leafId: string, session: NvimCanvasSession): void {
  sessions.set(leafId, session)
}

export function unregisterNvimSession(leafId: string): void {
  sessions.delete(leafId)
}

export function nvimSessionFor(leafId: string): NvimCanvasSession | undefined {
  return sessions.get(leafId)
}

// The editor session the user is currently in. Prefers the keymap's active
// leaf; falls back to the sole session when only one editor is open (a common
// case where focus may sit in another pane).
export function activeNvimSession(): NvimCanvasSession | undefined {
  const leafId = keymap.activeLeafId
  if (leafId) {
    const session = sessions.get(leafId)
    if (session) {
      lastEditorLeafId = leafId
      return session
    }
  }
  if (sessions.size === 1) {
    return sessions.values().next().value
  }
  return undefined
}

// An editor session to host a scratch buffer (e.g. batch rename), for callers
// that need *some* editor rather than the exact focused pane. Prefers the
// focused editor, then the most recently focused, then any open one — so it
// still resolves when focus sits in the file tree or another non-editor pane.
export function anyNvimSession(): NvimCanvasSession | undefined {
  const active = activeNvimSession()
  if (active) return active
  if (lastEditorLeafId) {
    const recent = sessions.get(lastEditorLeafId)
    if (recent) return recent
  }
  return sessions.values().next().value
}
