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
  // Editor-style mode the binding requires (e.g. 'normal'). Only meaningful
  // for panes that declare modes; a mode-less binding fires in any mode.
  mode?: string
  group?: string
  description: string
  when?: () => boolean
  run: () => void | Promise<void>
}

// A registered binding with its parsed sequence attached.
export interface ResolvedBinding extends KeyBinding {
  sequence: ParsedSequence
}

// A static which-key hint entry (see keymap.showHints).
export interface HintEntry {
  keys: string
  description: string
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

function sameModes(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((mode, index) => mode === b[index])
}

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

  // ── Modes ──────────────────────────────────────────────────────
  // Panes declare the modes they support when they register (e.g. the editor
  // declares the Vim modes, the terminal declares 'terminal') and report their
  // current mode as it changes. Mode-less panes have mode null.
  private supportedModes = $state<Record<PaneId, string[]>>({})
  private reportedModes = $state<Record<PaneId, string>>({})

  // Current mode of the active pane: its last report, clamped to its declared
  // modes, defaulting to the first declared mode. Null for mode-less panes.
  get mode(): string | null {
    const id = this.activePane
    if (!id) return null
    const supported = this.supportedModes[id]
    if (!supported || supported.length === 0) return null
    const reported = this.reportedModes[id]
    if (reported && supported.includes(reported)) return reported
    return supported[0]
  }

  setPaneMode(id: PaneId, mode: string): void {
    if (this.reportedModes[id] === mode) return
    this.reportedModes = { ...this.reportedModes, [id]: mode }
  }

  // ── Transient hints ────────────────────────────────────────────
  // Static which-key panels pushed by panes for key layers the registry does
  // not own (e.g. Vim operator-pending motions after `d`). Shown after the
  // which-key delay so fast sequences (dw) never flash the panel.
  hintTitle = $state<string | null>(null)
  hintEntries = $state<HintEntry[]>([])
  hintVisible = $state(false)
  private hintTimer: ReturnType<typeof setTimeout> | null = null

  showHints(title: string, entries: HintEntry[]): void {
    this.hintTitle = title
    this.hintEntries = entries
    if (this.hintTimer) clearTimeout(this.hintTimer)
    this.hintTimer = setTimeout(() => {
      if (this.hintTitle === title) this.hintVisible = true
    }, whichKeyDelay())
  }

  hideHints(): void {
    this.hintTitle = null
    this.hintEntries = []
    this.hintVisible = false
    if (this.hintTimer) {
      clearTimeout(this.hintTimer)
      this.hintTimer = null
    }
  }

  // Set by the keybind-capture widget so global dispatch stands down while it
  // records a sequence.
  captureMode = $state(false)

  // Full keybinding cheatsheet (leader ?) — a glanceable list of everything.
  cheatsheetOpen = $state(false)

  toggleCheatsheet(): void {
    this.cheatsheetOpen = !this.cheatsheetOpen
  }

  closeCheatsheet(): void {
    this.cheatsheetOpen = false
  }

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
  registerPane(id: PaneId, el: HTMLElement, type?: string, modes?: string[]): void {
    this.panes.set(id, el)
    if (type) this.paneTypes.set(id, type)
    else this.paneTypes.delete(id)
    // Only write when the mode list actually changed: registerPane re-runs on
    // every pane-action update, and an unconditional fresh object here
    // re-invalidates that same update — an infinite effect loop.
    const existing = this.supportedModes[id]
    if (modes && modes.length > 0) {
      if (!existing || !sameModes(existing, modes)) {
        this.supportedModes = { ...this.supportedModes, [id]: [...modes] }
      }
    } else if (existing) {
      const { [id]: _removed, ...rest } = this.supportedModes
      this.supportedModes = rest
    }
    if (this.activePane === id) this.refreshActive(id)
  }

  unregisterPane(id: PaneId): void {
    this.panes.delete(id)
    this.paneTypes.delete(id)
    if (this.supportedModes[id]) {
      const { [id]: _removedSupported, ...supported } = this.supportedModes
      this.supportedModes = supported
    }
    if (this.reportedModes[id]) {
      const { [id]: _removedReported, ...reported } = this.reportedModes
      this.reportedModes = reported
    }
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

  // ── Focus follows mouse ────────────────────────────────────────
  // Last cursor position seen by pointerFocus, to reject move events that
  // don't actually relocate the cursor (scrolling under a stationary pointer
  // still fires mousemove with unchanged coordinates).
  private lastPointerX = Number.NaN
  private lastPointerY = Number.NaN

  // Focus the pane the mouse is over. Called from the pane action's mousemove.
  // Because it only acts on real motion, a keyboard focus change persists until
  // the user moves the mouse — a parked cursor emits no mousemove.
  pointerFocus(id: PaneId, clientX: number, clientY: number): void {
    if (clientX === this.lastPointerX && clientY === this.lastPointerY) return
    this.lastPointerX = clientX
    this.lastPointerY = clientY
    if (this.activePane === id) return
    this.focusPane(id)
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
      // Skip panes in hidden views (display:none → no offset parent); their
      // zero-rects would otherwise be picked as bogus neighbors.
      if (el.offsetParent === null) continue
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
  // A binding context matches 'global', the active pane id, or its pane type;
  // a binding mode must match the active pane's current mode.
  matching(prefix: KeyStep[], leader: boolean): ResolvedBinding[] {
    return this.effective.filter((binding) => {
      if (binding.sequence.leader !== leader) return false
      const context = binding.context || 'global'
      const inContext =
        context === 'global' || context === this.activePane || context === this.activePaneType
      if (!inContext) return false
      if (binding.mode && binding.mode !== this.mode) return false
      if (binding.when && !binding.when()) return false
      return sequenceStartsWith(binding.sequence.steps, prefix)
    })
  }

  // ── Sequence engine ───────────────────────────────────────────
  private notTyping(): boolean {
    if (this.trustModeEligibility) return true
    const tag = document.activeElement?.tagName
    return tag !== 'INPUT' && tag !== 'TEXTAREA'
  }

  // Bare keys are only claimed from a mode-aware pane in normal mode, so Vim
  // insert-mode typing (or the terminal) is never hijacked.
  private eligible(): boolean {
    if (!this.notTyping()) return false
    const mode = this.mode
    if (mode !== null) return mode === 'normal'
    return true
  }

  // The leader may also start in visual mode (only the editor has one), so
  // selection-scoped bindings like <Leader> i fire without leaving visual first.
  private leaderEligible(): boolean {
    if (!this.notTyping()) return false
    const mode = this.mode
    if (mode !== null) return mode === 'normal' || mode === 'visual'
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

  // Set while dispatching a key that came from a mode-aware pane's own input
  // element (nvim's hidden contenteditable). Such panes decide typing vs.
  // command by their reported mode, so eligibility skips the INPUT/TEXTAREA
  // tag gate meant for plain text fields.
  private trustModeEligibility = false

  // Dispatch a key originating inside a mode-aware pane. Grove's leader and
  // chords overlay the pane: this consumes them (self-gated by the pane's
  // reported mode) and returns true; anything it doesn't claim returns false
  // so the pane can forward the key to its editor (e.g. nvim_input).
  handleKeyFromModePane(event: KeyboardEvent): boolean {
    this.trustModeEligibility = true
    try {
      return this.handleKey(event)
    } finally {
      this.trustModeEligibility = false
    }
  }

  // Main dispatch. Returns true if the key was consumed.
  handleKey(event: KeyboardEvent): boolean {
    // Lone modifier presses never advance or break a sequence.
    if (isModifierKey(event.key)) return this.pendingActive
    if (this.pendingActive) return this.handlePendingKey(event)

    const step = stepFromEvent(event)

    // Unmodified space starts the leader when we're not typing (normal or visual).
    if (step.key === 'space' && !step.ctrl && !step.alt && !step.meta) {
      if (!this.leaderEligible()) return false
      this.startPending(true)
      return true
    }

    // Non-leader bindings: modifier chords fire anywhere (they must beat
    // Neovim); bare keys only when not typing.
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
// Accepts a plain id or `{ id, type, modes }` — the type feeds context
// matching, `modes` declares the editor-style modes the pane supports.
export type PaneAttachment = PaneId | { id: PaneId; type?: string; modes?: string[] }

function attachmentParts(attachment: PaneAttachment): {
  id: PaneId
  type?: string
  modes?: string[]
} {
  if (typeof attachment === 'string') return { id: attachment }
  return attachment
}

export function pane(
  node: HTMLElement,
  attachment: PaneAttachment
): { update: (next: PaneAttachment) => void; destroy: () => void } {
  let current = attachmentParts(attachment)
  keymap.registerPane(current.id, node, current.type, current.modes)
  node.dataset.pane = current.id
  if (!node.hasAttribute('tabindex')) node.tabIndex = -1
  const activate = (event: Event): void => {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-pane]') === node) keymap.setActive(current.id)
  }
  // Focus follows mouse: hovering a pane focuses it. Only the innermost pane
  // under the cursor claims the move (same guard as activate), and a held
  // button (drag/selection) is left alone so it never yanks focus mid-drag.
  const follow = (event: MouseEvent): void => {
    if (event.buttons !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-pane]') !== node) return
    keymap.pointerFocus(current.id, event.clientX, event.clientY)
  }
  node.addEventListener('focusin', activate)
  node.addEventListener('mousedown', activate)
  node.addEventListener('mousemove', follow)
  return {
    update(next: PaneAttachment) {
      const parts = attachmentParts(next)
      if (parts.id !== current.id) keymap.unregisterPane(current.id)
      current = parts
      keymap.registerPane(current.id, node, current.type, current.modes)
      node.dataset.pane = current.id
    },
    destroy() {
      node.removeEventListener('focusin', activate)
      node.removeEventListener('mousedown', activate)
      node.removeEventListener('mousemove', follow)
      keymap.unregisterPane(current.id)
    }
  }
}
