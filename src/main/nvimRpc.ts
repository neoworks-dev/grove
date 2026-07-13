// Minimal msgpack-rpc session over a child process's stdio, for driving
// `nvim --embed`. Wire format: requests [0, msgid, method, args], responses
// [1, msgid, error, result], notifications [2, method, args]. Deliberately
// tiny — a UI client needs requests, notifications, and the redraw stream;
// the `neovim` npm package's Buffer/Window proxy layer is dead weight here.

import { encode, decodeMultiStream, ExtData } from '@msgpack/msgpack'
import type { Readable, Writable } from 'node:stream'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type NotificationHandler = (method: string, args: unknown[]) => void

// Redraw payloads must survive webContents.send; ExtData (Buffer/Window/
// Tabpage handles) and binary strings are normalized to plain values once at
// this boundary.
export function toPlain(value: unknown): unknown {
  if (value instanceof ExtData) return null
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  if (Array.isArray(value)) return value.map(toPlain)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = toPlain(entry)
    return out
  }
  return value
}

export class NvimRpc {
  private nextMsgId = 1
  private pending = new Map<number, PendingRequest>()
  private notificationHandler: NotificationHandler | null = null
  private closed = false

  constructor(
    private stdin: Writable,
    stdout: Readable
  ) {
    void this.readLoop(stdout)
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  request(method: string, args: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('nvim rpc channel closed'))
    const msgId = this.nextMsgId
    this.nextMsgId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(msgId, { resolve, reject })
      this.write([0, msgId, method, args])
    })
  }

  notify(method: string, args: unknown[]): void {
    if (this.closed) return
    this.write([2, method, args])
  }

  // Reject in-flight requests when the process dies.
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) {
      request.reject(new Error('nvim exited'))
    }
    this.pending.clear()
  }

  private write(message: unknown): void {
    try {
      this.stdin.write(encode(message))
    } catch {
      // stdin already closed; the exit handler cleans up
    }
  }

  private async readLoop(stdout: Readable): Promise<void> {
    try {
      for await (const message of decodeMultiStream(stdout)) {
        this.dispatch(message)
      }
    } catch {
      // stream torn down mid-message (process killed)
    }
    this.close()
  }

  private dispatch(message: unknown): void {
    if (!Array.isArray(message)) return
    if (message[0] === 1) {
      this.handleResponse(message)
      return
    }
    if (message[0] === 2) {
      const [, method, args] = message
      if (typeof method !== 'string' || !Array.isArray(args)) return
      this.notificationHandler?.(method, args)
    }
  }

  private handleResponse(message: unknown[]): void {
    const [, msgId, error, result] = message
    if (typeof msgId !== 'number') return
    const request = this.pending.get(msgId)
    if (!request) return
    this.pending.delete(msgId)
    if (error) {
      request.reject(new Error(formatRpcError(error)))
      return
    }
    request.resolve(result)
  }
}

function formatRpcError(error: unknown): string {
  // nvim errors are [type, message] tuples.
  if (Array.isArray(error) && typeof error[1] === 'string') return error[1]
  return JSON.stringify(toPlain(error))
}
