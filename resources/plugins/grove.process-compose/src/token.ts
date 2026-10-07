import type { CancellationToken } from '@grove/plugin-sdk'

// A token the plugin cancels itself, e.g. to end a stream it is reading.
export function cancellation(): { token: CancellationToken; cancel: () => void } {
  let cancelled = false
  const callbacks = new Set<() => void>()
  const token: CancellationToken = {
    get isCancelled() {
      return cancelled
    },
    onCancel(callback) {
      callbacks.add(callback)
      return { dispose: () => void callbacks.delete(callback) }
    }
  }
  const cancel = (): void => {
    if (cancelled) return
    cancelled = true
    for (const callback of callbacks) callback()
    callbacks.clear()
  }
  return { token, cancel }
}
