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

// ── Parking ──────────────────────────────────────────────────────
// Restructuring the split tree (opening a pane beside the editor, dragging a
// pane) rebuilds the Svelte subtree around a leaf, so its component is
// destroyed and immediately recreated. Killing nvim there restarted the whole
// editor — the visible "hard refresh". Instead the unmounting component parks
// its session and the remounting one adopts it. Nothing adopts a session that
// was unmounted for real (the pane was closed or changed type), so the timer
// below disposes it.
const PARK_GRACE_MS = 1000

const parkedSessions = new Map<string, { session: NvimCanvasSession; timer: number }>()

export function parkNvimSession(leafId: string, session: NvimCanvasSession): void {
  disposeParkedSession(leafId)
  const timer = window.setTimeout(() => {
    parkedSessions.delete(leafId)
    session.dispose()
  }, PARK_GRACE_MS)
  parkedSessions.set(leafId, { session, timer })
}

/** Take back the session parked for this leaf, if the pane is remounting. */
export function adoptParkedSession(leafId: string): NvimCanvasSession | undefined {
  const parked = parkedSessions.get(leafId)
  if (!parked) return undefined
  clearTimeout(parked.timer)
  parkedSessions.delete(leafId)
  return parked.session
}

/** Kill a parked session now (its pane is definitively gone). */
export function disposeParkedSession(leafId: string): void {
  const parked = parkedSessions.get(leafId)
  if (!parked) return
  clearTimeout(parked.timer)
  parkedSessions.delete(leafId)
  parked.session.dispose()
}

export function nvimSessionFor(leafId: string): NvimCanvasSession | undefined {
  return sessions.get(leafId)
}

/** Every registered editor session, for changes that concern all of them. */
export function allNvimSessions(): NvimCanvasSession[] {
  return [...sessions.values()]
}

// Look a session up by the nvim process it drives. Callers that must survive a
// leaf being renamed key on this instead of the leaf id.
export function sessionByNvimId(nvimId: string): NvimCanvasSession | undefined {
  for (const session of sessions.values()) {
    if (session.id === nvimId) return session
  }
  return undefined
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

// Resolve an attached editor session, waiting for one to spawn. A session
// registers on mount but only gets its nvim id once the process has attached,
// so callers that just mounted the editor pane must wait for both. Resolves
// undefined if nothing attaches within `timeoutMs`.
export function waitForNvimSession(timeoutMs = 5000): Promise<NvimCanvasSession | undefined> {
  const deadline = performance.now() + timeoutMs
  return new Promise((resolve) => {
    const poll = (): void => {
      const session = anyNvimSession()
      if (session && session.id) {
        resolve(session)
        return
      }
      if (performance.now() >= deadline) {
        resolve(undefined)
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
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
