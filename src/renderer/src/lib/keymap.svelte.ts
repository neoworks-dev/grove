// Keyboard + focus core. Everything keyboard-driven plugs in here:
//  - a focus model over named panes (spatial Ctrl+hjkl navigation),
//  - a plugin-extensible binding registry (same pattern as `commands`),
//  - a Vim-style leader engine (space) with a which-key overlay.
// The single window-level dispatch lives in App.svelte and delegates to
// `keymap.handleKey`. Pane-local motions (tree hjkl, editor Shift+hjkl) are
// handled by their components; this module owns cross-pane keys + the leader.

// Pane ids are free-form strings assigned by whoever registers the pane (core
// panes use "sidebar"/"tree"/"center"/"agent"/"logs"; plugins can add their
// own). Nothing here hardcodes the set.
export type PaneId = string

export interface KeyBinding {
  id: string
  // Token sequence AFTER the leader, space-separated. E.g. "space" (double
  // space), "f f", "w h". Tokens are single keys; "space" means the space key.
  keys: string
  // Where the binding is active: "global", or a specific pane id.
  context?: string
  group?: string
  description: string
  when?: () => boolean
  run: () => void | Promise<void>
}

import { startsWith, pickNeighbor } from './keymapCore'

const LEADER_DELAY_MS = 300

function tokenFor(event: KeyboardEvent): string {
  if (event.key === ' ' || event.key === 'Spacebar') return 'space'
  return event.key
}

class Keymap {
  activePane = $state<PaneId | null>(null)
  bindings = $state<KeyBinding[]>([])

  // The layout-tree leaf containing the active pane (a pane may be nested
  // inside a leaf, e.g. the file tree inside the files leaf).
  activeLeafId = $state<string | null>(null)

  // Pane type of the active pane (e.g. 'editor'), when the registrar gave one.
  activePaneTypeState = $state<string | null>(null)

  // Leader state (read by WhichKey.svelte).
  leaderActive = $state(false)
  leaderKeys = $state<string[]>([])
  whichKeyVisible = $state(false)

  // Published by EditorPane so the leader never hijacks Vim insert-mode typing.
  editorVimMode = $state<string>('normal')

  // Pane elements are plain (geometry is read on demand, not reactive).
  private panes = new Map<PaneId, HTMLElement>()
  private paneTypes = new Map<PaneId, string>()
  private leaderTimer: ReturnType<typeof setTimeout> | null = null

  get activePaneType(): string | null {
    return this.activePaneTypeState
  }

  // ── Focus model ───────────────────────────────────────────────
  registerPane(id: PaneId, el: HTMLElement, type?: string): void {
    this.panes.set(id, el)
    if (type) this.paneTypes.set(id, type)
    else this.paneTypes.delete(id)
    if (this.activePane === id) this.refreshActive(id)
  }

  unregisterPane(id: PaneId): void {
    this.panes.delete(id)
    this.paneTypes.delete(id)
  }

  setActive(id: PaneId): void {
    this.activePane = id
    this.refreshActive(id)
  }

  private refreshActive(id: PaneId): void {
    this.activePaneTypeState = this.paneTypes.get(id) ?? null
    const el = this.panes.get(id)
    const leafEl = el?.closest('[data-leaf]') as HTMLElement | null
    this.activeLeafId = leafEl?.dataset.leaf ?? null
  }

  focusPane(id: PaneId): void {
    const el = this.panes.get(id)
    if (!el) return
    // Focus the innermost nested pane (e.g. the file tree inside the sidebar
    // wrapper) so its key handler receives hjkl, not the non-handling wrapper.
    const target = this.innermostPane(id, el)
    target.el.focus({ preventScroll: true })
    this.activePane = target.id
  }

  private innermostPane(id: PaneId, el: HTMLElement): { id: PaneId; el: HTMLElement } {
    let best = { id, el }
    for (const [candidateId, candidateEl] of this.panes) {
      if (candidateEl !== best.el && best.el.contains(candidateEl)) {
        best = { id: candidateId, el: candidateEl }
      }
    }
    return best
  }

  // Nearest pane whose center lies in the given direction from `fromId`,
  // optionally restricted to a candidate set (layout leaf swaps).
  neighborPane(fromId: PaneId, dir: 'h' | 'j' | 'k' | 'l', candidates?: Set<PaneId>): PaneId | null {
    const from = this.panes.get(fromId)
    if (!from) return null
    const others: { id: string; rect: DOMRect }[] = []
    for (const [id, el] of this.panes) {
      if (id === fromId) continue
      if (candidates && !candidates.has(id)) continue
      others.push({ id, rect: el.getBoundingClientRect() })
    }
    return pickNeighbor(from.getBoundingClientRect(), others, dir)
  }

  // Move focus to the nearest pane whose center lies in the given direction.
  movePane(dir: 'h' | 'j' | 'k' | 'l'): void {
    if (!this.activePane) return
    const best = this.neighborPane(this.activePane, dir)
    if (best) this.focusPane(best)
  }

  // ── Binding registry ──────────────────────────────────────────
  registerBindings(list: KeyBinding[]): () => void {
    this.bindings = [...this.bindings, ...list]
    const ids = new Set(list.map((binding) => binding.id))
    return () => {
      this.bindings = this.bindings.filter((binding) => !ids.has(binding.id))
    }
  }

  // Bindings reachable in the current context matching the typed prefix.
  // A binding context matches 'global', the active pane id, or its pane type.
  matching(prefix: string[]): KeyBinding[] {
    return this.bindings.filter((binding) => {
      const context = binding.context || 'global'
      const inContext =
        context === 'global' || context === this.activePane || context === this.activePaneType
      if (!inContext) return false
      if (binding.when && !binding.when()) return false
      return startsWith(binding.keys.split(' '), prefix)
    })
  }

  // ── Leader engine ─────────────────────────────────────────────
  private eligible(): boolean {
    const el = document.activeElement
    const tag = el?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return false
    // The editor is a contenteditable; only steal space in Vim normal mode.
    if (this.activePaneType === 'editor') return this.editorVimMode === 'normal'
    return true
  }

  private startLeader(): void {
    this.leaderActive = true
    this.leaderKeys = []
    this.whichKeyVisible = false
    this.leaderTimer = setTimeout(() => {
      if (this.leaderActive) this.whichKeyVisible = true
    }, LEADER_DELAY_MS)
  }

  cancelLeader(): void {
    this.leaderActive = false
    this.leaderKeys = []
    this.whichKeyVisible = false
    if (this.leaderTimer) {
      clearTimeout(this.leaderTimer)
      this.leaderTimer = null
    }
  }

  // Main dispatch. Returns true if the key was consumed.
  handleKey(event: KeyboardEvent): boolean {
    if (this.leaderActive) return this.handleLeaderKey(event)

    // Ctrl+hjkl: spatial pane navigation (must beat CodeMirror/Vim).
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      const dir = { h: 'h', j: 'j', k: 'k', l: 'l' }[event.key] as
        | 'h'
        | 'j'
        | 'k'
        | 'l'
        | undefined
      if (dir) {
        this.movePane(dir)
        return true
      }
    }

    // Space starts the leader when we're not typing.
    if (tokenFor(event) === 'space' && !event.ctrlKey && !event.metaKey && this.eligible()) {
      this.startLeader()
      return true
    }
    return false
  }

  private handleLeaderKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.cancelLeader()
      return true
    }
    if (event.key === 'Backspace') {
      this.leaderKeys = this.leaderKeys.slice(0, -1)
      return true
    }
    // Ignore lone modifier presses so they don't break the sequence.
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return true

    const next = [...this.leaderKeys, tokenFor(event)]
    const matches = this.matching(next)
    const exact = matches.find((binding) => binding.keys.split(' ').length === next.length)
    if (exact) {
      this.cancelLeader()
      void exact.run()
      return true
    }
    if (matches.length > 0) {
      this.leaderKeys = next
      this.whichKeyVisible = true // deeper level: reveal immediately
      return true
    }
    // Dead end — swallow the key and drop out of leader mode.
    this.cancelLeader()
    return true
  }
}

export const keymap = new Keymap()

// Svelte action: register a DOM element as a focusable pane. Panes may nest
// (e.g. the file tree inside the files leaf); only the innermost pane under the
// event target claims focus, so a click in the tree doesn't also select the leaf.
// Accepts a plain id or `{ id, type }` — the type feeds context matching and
// the editor Vim guards.
export type PaneAttachment = PaneId | { id: PaneId; type?: string }

function attachmentParts(attachment: PaneAttachment): { id: PaneId; type?: string } {
  if (typeof attachment === 'string') return { id: attachment }
  return attachment
}

export function pane(
  node: HTMLElement,
  attachment: PaneAttachment
): { update: (next: PaneAttachment) => void; destroy: () => void } {
  let current = attachmentParts(attachment)
  keymap.registerPane(current.id, node, current.type)
  node.dataset.pane = current.id
  if (!node.hasAttribute('tabindex')) node.tabIndex = -1
  const activate = (event: Event): void => {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-pane]') === node) keymap.setActive(current.id)
  }
  node.addEventListener('focusin', activate)
  node.addEventListener('mousedown', activate)
  return {
    update(next: PaneAttachment) {
      const parts = attachmentParts(next)
      if (parts.id !== current.id) keymap.unregisterPane(current.id)
      current = parts
      keymap.registerPane(current.id, node, current.type)
      node.dataset.pane = current.id
    },
    destroy() {
      node.removeEventListener('focusin', activate)
      node.removeEventListener('mousedown', activate)
      keymap.unregisterPane(current.id)
    }
  }
}
