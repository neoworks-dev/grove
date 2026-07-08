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
  isCancelled: boolean
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

const ITEM_CAP = 1000
const DEFAULT_DEBOUNCE_MS = 120

class OverlayController {
  active = $state<OverlayDescriptor | null>(null)
  query = $state('')
  items = $state<OverlayItem[]>([])
  activeIndex = $state(0)
  selectedIds = $state<Set<string>>(new Set())
  preview = $state<OverlayPreviewContent | null>(null)

  private queryTimer: ReturnType<typeof setTimeout> | null = null
  private queryToken: OverlayToken | null = null
  private previewToken: OverlayToken | null = null
  private appliedInitialFocus = false

  isOpen(id: string): boolean {
    return this.active?.id === id
  }

  show(descriptor: OverlayDescriptor): void {
    if (this.active) this.dismiss()
    this.active = descriptor
    this.query = ''
    this.items = []
    this.activeIndex = 0
    this.selectedIds = new Set()
    this.preview = null
    this.appliedInitialFocus = false
    this.runQuery('')
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
    if (this.queryToken) this.queryToken.isCancelled = true
    const token: OverlayToken = { isCancelled: false }
    this.queryToken = token
    this.items = []
    const emit: OverlayEmit = (batch, options) => {
      if (token.isCancelled || this.active !== descriptor) return
      const base = options?.replace ? [] : this.items
      this.items = [...base, ...batch].slice(0, ITEM_CAP)
      this.afterEmit(descriptor)
    }
    void descriptor.onQuery(query, emit, token)
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
    this.focusIndex(this.activeIndex + delta)
  }

  private schedulePreview(): void {
    const descriptor = this.active
    const item = this.items[this.activeIndex]
    if (!descriptor?.onPreview || !item) return
    if (this.previewToken) this.previewToken.isCancelled = true
    const token: OverlayToken = { isCancelled: false }
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
    if (this.queryToken) this.queryToken.isCancelled = true
    if (this.previewToken) this.previewToken.isCancelled = true
    this.active = null
    this.items = []
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
