// Dialogs + notifications — a canonical control surface. Modal confirms are
// queued (one visible at a time) and resolve with the picked action id;
// toasts stack and auto-dismiss. Used by trust/consent flows, keybind
// conflicts, and action errors; plugins reach it via sdk.ui.dialogs/notify.

export interface DialogAction {
  id: string
  label: string
  kind?: 'primary' | 'danger' | 'default'
}

export interface DialogOptions {
  title: string
  body: string
  // Monospace block under the body (e.g. the exact shell command).
  detail?: string
  actions: DialogAction[]
}

interface PendingDialog extends DialogOptions {
  id: number
  resolve: (actionId: string) => void
}

export type NotificationLevel = 'info' | 'warn' | 'error'

export interface Notification {
  id: number
  level: NotificationLevel
  message: string
}

const DEFAULT_TOAST_MS = 4000

let nextId = 0

class DialogController {
  queue = $state<PendingDialog[]>([])
  toasts = $state<Notification[]>([])

  get active(): PendingDialog | null {
    return this.queue[0] ?? null
  }

  // Resolves with the picked action id, or 'cancel' on dismiss (Escape or
  // backdrop click).
  confirm(options: DialogOptions): Promise<string> {
    return new Promise((resolve) => {
      nextId += 1
      this.queue = [...this.queue, { ...options, id: nextId, resolve }]
    })
  }

  resolveActive(actionId: string): void {
    const active = this.active
    if (!active) return
    this.queue = this.queue.slice(1)
    active.resolve(actionId)
  }

  notify(options: { level: NotificationLevel; message: string; timeoutMs?: number }): void {
    nextId += 1
    const toast: Notification = { id: nextId, level: options.level, message: options.message }
    this.toasts = [...this.toasts, toast]
    setTimeout(() => this.dismiss(toast.id), options.timeoutMs ?? DEFAULT_TOAST_MS)
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id)
  }
}

export const dialogs = new DialogController()
