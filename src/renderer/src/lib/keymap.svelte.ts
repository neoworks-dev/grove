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
  // Canonical key sequence (see keySequence.ts): leader sequences like
  // "leader w h" and modifier chords like "ctrl+k ctrl+s".
  keys: string
  // Where the binding is active: "global", a pane id, or a pane type.
  context?: string
  group?: string
  description: string
  when?: () => boolean
  run: () => void | Promise<void>
}

// A registered binding with its parsed sequence attached.
export interface ResolvedBinding extends KeyBinding {
  sequence: ParsedSequence
}

import { pickNeighbor } from './keymapCore'
import {
  parseSequence,
  stepFromEvent,
  sequenceStartsWith,
  isModifierKey,
  type KeyStep,
  type ParsedSequence
} from './keySequence'

import { settings } from './settings.svelte'
import {
  resolveDefaultBindings,
  readCustomBindings,
  readOverrideMap
} from './bindingResolution'
import { executeAction } from './actions.svelte'

// Fallback when the workbench.whichKeyDelay setting isn't loaded yet.
const LEADER_DELAY_MS = 300

function whichKeyDelay(): number {
  const configured = settings.get<number>('workbench.whichKeyDelay')
  if (typeof configured === 'number' && configured >= 0) return configured
  return LEADER_DELAY_MS
}

class Keymap {
  activePane = $state<PaneId | null>(null)
  bindings = $state<ResolvedBinding[]>([])

  // The layout-tree leaf containing the active pane (a pane may be nested
  // inside a leaf, e.g. the file tree inside the files leaf).
  activeLeafId = $state<string | null>(null)

  // Pane type of the active pane (e.g. 'editor'), when the registrar gave one.
  activePaneTypeState = $state<string | null>(null)

  // Pending-sequence state (read by WhichKey.svelte). A pending sequence is
  // either a leader sequence (space …) or a chord prefix (ctrl+k …).
  pendingActive = $state(false)
  pendingLeader = $state(false)
  pendingSteps = $state<KeyStep[]>([])
  whichKeyVisible = $state(false)

  // Published by EditorPane so the leader never hijacks Vim insert-mode typing.
  editorVimMode = $state<string>('normal')

  // Pane elements are plain (geometry is read on demand, not reactive).
  private panes = new Map<PaneId, HTMLElement>()
  private paneTypes = new Map<PaneId, string>()
  private leaderTimer: ReturnType<typeof setTimeout> | null = null

  // Effective bindings: registered defaults with user/project overrides from
  // the settings provider applied (null override = unbound), plus custom
  // bindings whose run executes a keybind action. Re-derives on any settings
  // or registration change.
  effective = $derived.by<ResolvedBinding[]>(() => {
    const userOverrides = readOverrideMap(settings.userValues['keybindings.overrides'])
    const projectOverrides = readOverrideMap(settings.projectValues['keybindings.overrides'])
    const resolved = resolveDefaultBindings(this.bindings, userOverrides, projectOverrides)
    const byId = new Map(this.bindings.map((binding) => [binding.id, binding]))
    const active: ResolvedBinding[] = []
    for (const entry of resolved) {
      if (entry.unbound) continue
      const base = byId.get(entry.id)
      if (!base) continue
      active.push({ ...base, keys: entry.keys, sequence: entry.sequence })
    }
    const custom = [
      ...readCustomBindings(settings.userValues['keybindings.custom'], 'custom-user'),
      ...readCustomBindings(settings.projectValues['keybindings.custom'], 'custom-project')
    ]
    for (const { binding, sequence, source } of custom) {
      active.push({
        id: binding.id,
        keys: binding.keys,
        context: binding.context,
        group: 'Custom',
        description: binding.description,
        sequence,
        run: () => executeAction(binding.action, source === 'custom-project')
      })
    }
    return active
  })

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
  // Invalid sequences (e.g. from hand-edited settings) are skipped with a
  // console warning rather than failing the whole batch.
  registerBindings(list: KeyBinding[]): () => void {
    const resolved: ResolvedBinding[] = []
    for (const binding of list) {
      const sequence = parseSequence(binding.keys)
      if (!sequence) {
        console.warn(`keymap: ignoring binding "${binding.id}" with invalid keys "${binding.keys}"`)
        continue
      }
      resolved.push({ ...binding, sequence })
    }
    this.bindings = [...this.bindings, ...resolved]
    const ids = new Set(resolved.map((binding) => binding.id))
    return () => {
      this.bindings = this.bindings.filter((binding) => !ids.has(binding.id))
    }
  }

  // Bindings reachable in the current context matching the typed step prefix.
  // A binding context matches 'global', the active pane id, or its pane type.
  matching(prefix: KeyStep[], leader: boolean): ResolvedBinding[] {
    return this.effective.filter((binding) => {
      if (binding.sequence.leader !== leader) return false
      const context = binding.context || 'global'
      const inContext =
        context === 'global' || context === this.activePane || context === this.activePaneType
      if (!inContext) return false
      if (binding.when && !binding.when()) return false
      return sequenceStartsWith(binding.sequence.steps, prefix)
    })
  }

  // ── Sequence engine ───────────────────────────────────────────
  private eligible(): boolean {
    const el = document.activeElement
    const tag = el?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return false
    // The editor is a contenteditable; only steal space in Vim normal mode.
    if (this.activePaneType === 'editor') return this.editorVimMode === 'normal'
    return true
  }

  private startPending(leader: boolean, steps: KeyStep[] = []): void {
    this.pendingActive = true
    this.pendingLeader = leader
    this.pendingSteps = steps
    // Leader waits before revealing which-key; chord prefixes are deliberate,
    // so their hints show immediately.
    this.whichKeyVisible = !leader
    if (!leader) return
    this.leaderTimer = setTimeout(() => {
      if (this.pendingActive) this.whichKeyVisible = true
    }, whichKeyDelay())
  }

  cancelPending(): void {
    this.pendingActive = false
    this.pendingSteps = []
    this.whichKeyVisible = false
    if (this.leaderTimer) {
      clearTimeout(this.leaderTimer)
      this.leaderTimer = null
    }
  }

  // Main dispatch. Returns true if the key was consumed.
  handleKey(event: KeyboardEvent): boolean {
    // Lone modifier presses never advance or break a sequence.
    if (isModifierKey(event.key)) return this.pendingActive
    if (this.pendingActive) return this.handlePendingKey(event)

    const step = stepFromEvent(event)

    // Unmodified space starts the leader when we're not typing.
    if (step.key === 'space' && !step.ctrl && !step.alt && !step.meta) {
      if (!this.eligible()) return false
      this.startPending(true)
      return true
    }

    // Non-leader bindings: modifier chords fire anywhere (they must beat
    // CodeMirror/Vim); bare keys only when not typing.
    const hasModifier = step.ctrl || step.alt || step.meta
    if (!hasModifier && !this.eligible()) return false
    const matches = this.matching([step], false)
    if (matches.length === 0) return false
    const exact = matches.find((binding) => binding.sequence.steps.length === 1)
    if (exact) {
      void exact.run()
      return true
    }
    this.startPending(false, [step])
    return true
  }

  private handlePendingKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.cancelPending()
      return true
    }
    if (event.key === 'Backspace') {
      this.pendingSteps = this.pendingSteps.slice(0, -1)
      return true
    }

    const next = [...this.pendingSteps, stepFromEvent(event)]
    const matches = this.matching(next, this.pendingLeader)
    const exact = matches.find((binding) => binding.sequence.steps.length === next.length)
    if (exact) {
      this.cancelPending()
      void exact.run()
      return true
    }
    if (matches.length > 0) {
      this.pendingSteps = next
      this.whichKeyVisible = true // deeper level: reveal immediately
      return true
    }
    // Dead end — swallow the key and drop out of the sequence.
    this.cancelPending()
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
