// Undo history — the canonical overlay listing the current buffer's undo states
// (undotree replacement). Data comes from vim.fn.undotree() over RPC; accepting
// a state runs `:undo <seq>` to jump the buffer there.

import { overlays, type OverlayItem } from './overlays.svelte'
import { activeNvimSession } from './nvim/registry'
import { layout } from './layout.svelte'

const OVERLAY_ID = 'undotree'

interface UndoEntry {
  seq: number
  time: number // epoch seconds
  save?: number
  cur: boolean
  depth: number
}

interface UndoTree {
  entries: UndoEntry[]
  seq_cur: number
}

// Flatten the undo tree depth-first, tagging the current state. Alternate
// branches (e.branch) nest one level deeper.
const UNDO_LUA = `
local tree = vim.fn.undotree()
local out = {}
local function walk(entries, depth)
  for _, e in ipairs(entries or {}) do
    out[#out + 1] = { seq = e.seq, time = e.time, save = e.save, cur = (e.seq == tree.seq_cur), depth = depth }
    if e.alt then walk(e.alt, depth + 1) end
  end
end
walk(tree.entries, 0)
return { entries = out, seq_cur = tree.seq_cur }
`

function relativeTime(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

async function fetchUndoTree(): Promise<UndoTree | null> {
  const id = activeNvimSession()?.id
  if (!id) return null
  try {
    const result = await window.workbench.nvim.request(id, 'nvim_exec_lua', [UNDO_LUA, []])
    if (!result || typeof result !== 'object') return null
    return result as UndoTree
  } catch {
    return null
  }
}

function toItem(entry: UndoEntry): OverlayItem {
  const indent = '  '.repeat(entry.depth)
  const marks: string[] = [relativeTime(entry.time)]
  if (entry.save) marks.push('saved')
  if (entry.cur) marks.push('current')
  return {
    id: String(entry.seq),
    label: `${indent}#${entry.seq}`,
    detail: marks.join(' · '),
    data: entry
  }
}

class UndoTreeStore {
  async show(): Promise<void> {
    const tree = await fetchUndoTree()
    // Newest state first; state 0 (original) sits at the bottom.
    const entries = tree ? [...tree.entries].reverse() : []
    overlays.show({
      id: OVERLAY_ID,
      placeholder: 'Undo history…',
      debounceMs: 0,
      initialFocus: (items) => items.findIndex((item) => (item.data as UndoEntry).cur),
      onQuery: (_query, emit) => emit(entries.map(toItem), { replace: true }),
      onAccept: (picked) => this.restore(picked[0])
    })
  }

  private restore(item: OverlayItem | undefined): void {
    if (!item) return
    const session = activeNvimSession()
    if (!session?.id) return
    const entry = item.data as UndoEntry
    layout.showCenterPane('nvim')
    void window.workbench.nvim
      .request(session.id, 'nvim_command', [`undo ${entry.seq}`])
      .then(() => session.focus())
  }

  toggle(): void {
    if (overlays.isOpen(OVERLAY_ID)) {
      overlays.cancel()
      return
    }
    void this.show()
  }
}

export const undoTree = new UndoTreeStore()
