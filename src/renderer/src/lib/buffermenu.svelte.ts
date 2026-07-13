// Buffer menu (leader b) — an instance of the canonical overlay listing the
// open editor tabs of the current worktree, with pin/close footer actions.

import { overlays, matchesQuery, type OverlayItem } from './overlays.svelte'
import { store } from './store.svelte'
import { layout } from './layout.svelte'
import { fileIcon } from './icons'

const OVERLAY_ID = 'buffers'

function bufferItems(query: string): OverlayItem[] {
  return store.tabs
    .filter((tab) => tab.worktreeId === store.selectedWorktreeId)
    .filter((tab) => matchesQuery(`${tab.name} ${tab.path}`, query))
    .map((tab) => {
      const item: OverlayItem = { id: tab.path, label: tab.name, icon: fileIcon(tab.name) }
      if (tab.pinned) item.trailingIcon = 'ph:push-pin-fill'
      return item
    })
}

class BufferMenuStore {
  show(): void {
    overlays.show({
      id: OVERLAY_ID,
      placeholder: 'Buffers…',
      debounceMs: 0,
      initialFocus: (items) => items.findIndex((item) => item.id === store.activeTabPath),
      onQuery: (query, emit) => emit(bufferItems(query), { replace: true }),
      onAccept: (picked) => {
        if (!picked[0]) return
        store.activeTabPath = picked[0].id
        layout.showCenterPane('nvim')
      },
      actions: [
        {
          key: 'ctrl+p',
          label: 'Pin',
          keepOpen: true,
          run: (picked) => store.togglePin(picked[0].id)
        },
        {
          key: 'ctrl+d',
          label: 'Close',
          keepOpen: true,
          run: (picked) => store.closeTab(picked[0].id)
        },
        {
          key: 'ctrl+o',
          label: 'Close others',
          keepOpen: true,
          run: (picked) => store.closeOtherTabs(picked[0].id)
        }
      ]
    })
  }

  toggle(): void {
    if (overlays.isOpen(OVERLAY_ID)) {
      overlays.cancel()
      return
    }
    this.show()
  }

  close(): void {
    if (overlays.isOpen(OVERLAY_ID)) overlays.cancel()
  }
}

export const bufferMenu = new BufferMenuStore()
