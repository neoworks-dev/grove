// Open/close state for the filename quick-open overlay (leader + space).
class FileFinderStore {
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

export const fileFinder = new FileFinderStore()
