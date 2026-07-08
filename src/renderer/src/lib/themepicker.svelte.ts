// Color-theme picker — an instance of the canonical overlay. Focusing a row
// live-previews the theme; Enter keeps it, Escape restores the original.

import { overlays, matchesQuery, type OverlayItem } from './overlays.svelte'
import { availableThemes, currentThemeName } from './themes'
import { applyColorTheme } from './store.svelte'
import ThemeSwatchRow from '../components/ThemeSwatchRow.svelte'

const OVERLAY_ID = 'themes'

class ThemePickerStore {
  show(): void {
    const originalName = currentThemeName()
    overlays.show({
      id: OVERLAY_ID,
      placeholder: 'Switch color theme…  ( ↑↓ preview · enter apply · esc cancel )',
      debounceMs: 0,
      itemComponent: ThemeSwatchRow,
      initialFocus: (items) => items.findIndex((item) => item.id === originalName),
      onQuery: (query, emit) => {
        const items: OverlayItem[] = availableThemes()
          .filter((theme) => matchesQuery(`${theme.label} ${theme.scheme}`, query))
          .map((theme) => ({ id: theme.name, label: theme.label, data: theme }))
        emit(items, { replace: true })
      },
      onFocus: (item) => applyColorTheme(item.id),
      // Focus already applied the theme; accepting just keeps it.
      onAccept: () => {},
      onCancel: () => applyColorTheme(originalName)
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

export const themePicker = new ThemePickerStore()
