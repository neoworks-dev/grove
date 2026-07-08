// Open/close state for the buffer menu overlay (leader b).
class BufferMenuStore {
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

export const bufferMenu = new BufferMenuStore()
