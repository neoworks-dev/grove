// Open/close state for the ripgrep search overlay (double-space / command).
class SearchStore {
  open = $state(false)

  toggle(): void {
    this.open = !this.open
  }

  show(): void {
    this.open = true
  }

  close(): void {
    this.open = false
  }
}

export const search = new SearchStore()
