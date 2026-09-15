// Canonical overlay — the rofi-style control surface every quick picker goes
// through (command palette, buffers, themes, plugin overlays). One controller,
// one component (Overlay.svelte); openers provide a descriptor with a
// streaming query handler and optional preview/multi-select/footer actions.

import type { Component } from 'svelte'

export interface OverlayItem {
  id: string
  label: string
  description?: string
  // Dim right-aligned text (group, path:line).
  detail?: string
  // Iconify icon name.
  icon?: string
  trailingIcon?: string
  data?: unknown
}

export type OverlayPreviewContent =
  | { kind: 'excerpt'; file: string; lines: { n: number; text: string }[]; highlightLine?: number }
  | { kind: 'text'; text: string }
  | { kind: 'component'; component: Component; props?: Record<string, unknown> }

export interface OverlayToken {
  readonly isCancelled: boolean
  onCancel: (callback: () => void) => void
}

class CancellableToken implements OverlayToken {
  isCancelled = false
  private callbacks: (() => void)[] = []

  onCancel(callback: () => void): void {
    this.callbacks.push(callback)
  }

  cancel(): void {
    if (this.isCancelled) return
    this.isCancelled = true
    for (const callback of this.callbacks) callback()
  }
}

export type OverlayEmit = (items: OverlayItem[], options?: { replace?: boolean }) => void

export interface OverlayAction {
  // Canonical single step, e.g. 'ctrl+d' (plain letters would fight the input).
  key: string
  label: string
  // Keep the overlay open and re-run the query afterwards (list actions).
  keepOpen?: boolean
  run: (picked: OverlayItem[]) => void | Promise<void>
}

export interface OverlayDescriptor {
  id: string
  placeholder: string
  multiSelect?: boolean
  debounceMs?: number
  // Prefill the input (e.g. rename pre-filled with the current symbol).
  initialQuery?: string
  // Custom row renderer (props: item, active); default row shows icon/label/detail.
  itemComponent?: Component
  // Applied once after the first emit (e.g. start on the active buffer).
  initialFocus?: (items: OverlayItem[]) => number
  onQuery: (query: string, emit: OverlayEmit, token: OverlayToken) => void | Promise<void>
  onPreview?: (item: OverlayItem, token: OverlayToken) => Promise<OverlayPreviewContent | null>
  // Focus follows selection (live theme preview).
  onFocus?: (item: OverlayItem) => void
  onAccept: (picked: OverlayItem[]) => void | Promise<void>
  onCancel?: () => void
  actions?: OverlayAction[]
}

/**
 * How many results are drawn to begin with.
 *
 * Every item is a real row — no windowing — so this is what one keystroke costs
 * to render, and a search that matches half a monorepo used to spend two minutes
 * drawing rows nobody had scrolled to yet.
 */
const INITIAL_ROWS = 200

/** How many more are drawn each time the list is scrolled to its end. */
const ROWS_PER_PAGE = 50

/**
 * How many results are held at all.
 *
 * Everything past this is genuinely dropped rather than waiting to be scrolled
 * to: holding a hundred thousand matches for a query about to be retyped costs
 * memory for nothing, and a search that deep wants narrowing, not scrolling.
 */
const BUFFER_CAP = 2000

const DEFAULT_DEBOUNCE_MS = 120

class OverlayController {
  active = $state<OverlayDescriptor | null>(null)
  query = $state('')
  /** The rows on screen: the head of what has arrived, grown by scrolling. */
  items = $state<OverlayItem[]>([])
  activeIndex = $state(0)
  selectedIds = $state<Set<string>>(new Set())
  preview = $state<OverlayPreviewContent | null>(null)
  /** More was found than is being held, so the list can say the rest is unseen. */
  capped = $state(false)
  /** Results are in hand that are not drawn yet; scrolling reveals them. */
  hasMore = $state(false)

  private queryTimer: ReturnType<typeof setTimeout> | null = null
  private queryToken: CancellableToken | null = null
  private previewToken: CancellableToken | null = null
  private appliedInitialFocus = false
  // Everything received for the current query, drawn or not.
  private buffered: OverlayItem[] = []
  // Results waiting for the next frame, and the frame they are waiting for.
  private incoming: OverlayItem[] = []
  private flushHandle: number | null = null

  isOpen(id: string): boolean {
    return this.active?.id === id
  }

  show(descriptor: OverlayDescriptor): void {
    if (this.active) this.dismiss()
    this.active = descriptor
    this.query = descriptor.initialQuery ?? ''
    this.clearResults()
    this.activeIndex = 0
    this.selectedIds = new Set()
    this.preview = null
    this.appliedInitialFocus = false
    this.runQuery(this.query)
  }

  setQuery(query: string): void {
    this.query = query
    if (this.queryTimer) clearTimeout(this.queryTimer)
    const delay = this.active?.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.queryTimer = setTimeout(() => this.runQuery(query), delay)
  }

  private runQuery(query: string): void {
    const descriptor = this.active
    if (!descriptor) return
    this.queryToken?.cancel()
    const token = new CancellableToken()
    this.queryToken = token
    this.clearResults()

    const emit: OverlayEmit = (batch, options) => {
      if (token.isCancelled || this.active !== descriptor) return
      if (options?.replace) this.clearResults()
      this.receive(batch, descriptor)
    }
    void descriptor.onQuery(query, emit, token)
  }

  /**
   * Take a batch of results.
   *
   * A streaming source pushes for as long as it is finding things — ripgrep on a
   * monorepo emits for minutes — so what arrives is held and only the first
   * screenful is drawn. Batches land on the next frame together rather than each
   * one re-rendering the list on its own.
   */
  private receive(batch: OverlayItem[], descriptor: OverlayDescriptor): void {
    if (this.buffered.length + this.incoming.length >= BUFFER_CAP) {
      this.capped = true
      return
    }
    this.incoming = [...this.incoming, ...batch]
    if (this.flushHandle !== null) return
    this.flushHandle = requestAnimationFrame(() => {
      this.flushHandle = null
      this.flush(descriptor)
    })
  }

  private flush(descriptor: OverlayDescriptor): void {
    if (this.active !== descriptor) return
    const arrived = this.incoming
    this.incoming = []
    if (arrived.length === 0) return

    const next = [...this.buffered, ...arrived]
    if (next.length > BUFFER_CAP) this.capped = true
    this.buffered = next.slice(0, BUFFER_CAP)
    // Rows already on screen stay; a first batch fills the screen, and later
    // ones only make more available to scroll to.
    this.draw(Math.max(this.items.length, INITIAL_ROWS))
    this.afterEmit(descriptor)
  }

  /**
   * Draw more of what has already arrived.
   *
   * Called as the list is scrolled to its end, and as the selection reaches the
   * last row — a list that grows under the keyboard as readily as under the
   * mouse is the difference between a cap and a page.
   */
  revealMore(): void {
    if (!this.hasMore) return
    this.draw(this.items.length + ROWS_PER_PAGE)
  }

  private draw(count: number): void {
    this.items = this.buffered.slice(0, count)
    this.hasMore = this.items.length < this.buffered.length
  }

  private clearResults(): void {
    if (this.flushHandle !== null) cancelAnimationFrame(this.flushHandle)
    this.flushHandle = null
    this.incoming = []
    this.buffered = []
    this.items = []
    this.capped = false
    this.hasMore = false
  }

  private afterEmit(descriptor: OverlayDescriptor): void {
    if (!this.appliedInitialFocus && descriptor.initialFocus && this.items.length > 0) {
      this.appliedInitialFocus = true
      this.focusIndex(descriptor.initialFocus(this.items))
      return
    }
    if (this.activeIndex >= this.items.length) {
      this.activeIndex = Math.max(0, this.items.length - 1)
    }
    this.schedulePreview()
  }

  focusIndex(index: number): void {
    if (this.items.length === 0) return
    this.activeIndex = Math.min(Math.max(index, 0), this.items.length - 1)
    const item = this.items[this.activeIndex]
    this.active?.onFocus?.(item)
    this.schedulePreview()
  }

  move(delta: number): void {
    // Walking onto the last row draws the next page, so the keyboard reaches
    // everything the mouse can scroll to.
    if (delta > 0 && this.activeIndex + delta >= this.items.length - 1) this.revealMore()
    this.focusIndex(this.activeIndex + delta)
  }

  private schedulePreview(): void {
    const descriptor = this.active
    const item = this.items[this.activeIndex]
    if (!descriptor?.onPreview || !item) return
    this.previewToken?.cancel()
    const token = new CancellableToken()
    this.previewToken = token
    void descriptor.onPreview(item, token).then((content) => {
      if (!token.isCancelled && this.active === descriptor) this.preview = content
    })
  }

  toggleSelected(): void {
    const item = this.items[this.activeIndex]
    if (!item || !this.active?.multiSelect) return
    const next = new Set(this.selectedIds)
    if (next.has(item.id)) next.delete(item.id)
    else next.add(item.id)
    this.selectedIds = next
  }

  private picked(): OverlayItem[] {
    if (this.active?.multiSelect && this.selectedIds.size > 0) {
      return this.items.filter((item) => this.selectedIds.has(item.id))
    }
    const item = this.items[this.activeIndex]
    return item ? [item] : []
  }

  accept(): void {
    const descriptor = this.active
    if (!descriptor) return
    const picked = this.picked()
    this.dismiss()
    if (picked.length > 0) void descriptor.onAccept(picked)
  }

  runAction(action: OverlayAction): void {
    const picked = this.picked()
    if (picked.length === 0) return
    if (!action.keepOpen) {
      this.dismiss()
      void action.run(picked)
      return
    }
    void Promise.resolve(action.run(picked)).then(() => this.runQuery(this.query))
  }

  cancel(): void {
    const descriptor = this.active
    this.dismiss()
    descriptor?.onCancel?.()
  }

  private dismiss(): void {
    if (this.queryTimer) clearTimeout(this.queryTimer)
    this.queryToken?.cancel()
    this.previewToken?.cancel()
    this.clearResults()
    this.active = null
    this.preview = null
  }
}

export const overlays = new OverlayController()

// Shared multi-word substring filter (every term must appear in the haystack).
export function matchesQuery(haystack: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true
  const lower = haystack.toLowerCase()
  return trimmed.split(/\s+/).every((term) => lower.includes(term))
}
