// What an agent asked to put on screen, handed to whoever can show it.
//
// The agent pane does not know how to open an issue or a diff, and should not:
// the feature that owns each kind of target registers the handler for it, the
// way it registers its panes. A kind nobody handles is dropped — the tool call
// is still in the transcript, and the agent was told the user may not see it.

import { dialogs } from '../dialogs.svelte'
import { keymap } from '../keymap.svelte'
import type { ShowTarget } from './types'

/** The worktree the asking session works in. */
export interface ShowWorktree {
  id: string
  path: string
}

type ShowKind = ShowTarget['kind']

export type ShowHandler<Kind extends ShowKind> = (
  worktree: ShowWorktree,
  target: Extract<ShowTarget, { kind: Kind }>
) => void | Promise<void>

// Stored loosely: the kind a handler was registered under is what guarantees
// the target it is given has that kind.
type AnyShowHandler = (worktree: ShowWorktree, target: ShowTarget) => void | Promise<void>

const handlers = new Map<ShowKind, AnyShowHandler>()

/** Take over showing one kind of target; returns the unregister. */
export function registerShowHandler<Kind extends ShowKind>(
  kind: Kind,
  handler: ShowHandler<Kind>
): () => void {
  const stored = handler as unknown as AnyShowHandler
  handlers.set(kind, stored)
  return () => {
    if (handlers.get(kind) === stored) handlers.delete(kind)
  }
}

/**
 * Show a target through the handler registered for its kind.
 *
 * Opening a pane focuses it, but the agent is the one opening it: the user may
 * be halfway through a sentence in the composer. So the keyboard is handed back
 * to whatever had it once the handler is done.
 */
export async function showTarget(worktree: ShowWorktree, target: ShowTarget): Promise<void> {
  const handler = handlers.get(target.kind)
  if (!handler) return
  const leafId = keymap.activeLeafId
  const element = document.activeElement
  await handler(worktree, target)
  restoreFocus(leafId, element)
  announce(target)
}

// Long enough to read two or three sentences, which is what a note may hold.
const NOTE_TOAST_MS = 12_000

/** Say what the user is looking at, when the agent wrote it down. */
function announce(target: ShowTarget): void {
  if (!target.note) return
  dialogs.notify({ level: 'info', message: target.note, timeoutMs: NOTE_TOAST_MS })
}

/**
 * Give focus back to a pane and the element inside it. Two frames, because the
 * pane that was opened takes focus a frame after it mounts.
 */
function restoreFocus(leafId: string | null, element: Element | null): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (leafId) keymap.focusPane(leafId)
      if (element instanceof HTMLElement && element.isConnected) {
        element.focus({ preventScroll: true })
      }
    })
  )
}

/** A path an agent wrote, made relative to the worktree. */
export function relativeIn(worktree: ShowWorktree, path: string): string {
  const prefix = `${worktree.path}/`
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return path
}
