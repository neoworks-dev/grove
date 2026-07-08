// Open/close state for the color-theme picker overlay (command palette:
// "Switch Color Theme"). The picker live-previews the focused theme and
// commits on Enter, so it only needs open/close here.
class ThemePickerStore {
  open = $state(false)

  show(): void {
    this.open = true
  }

  close(): void {
    this.open = false
  }

  toggle(): void {
    this.open = !this.open
  }
}

export const themePicker = new ThemePickerStore()
