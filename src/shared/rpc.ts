// RPC endpoint over a postMessage-style channel — used on both sides of the
// plugin worker boundary (host uses even ids, worker odd) and per-connection
// on the external app socket. Pure module, no runes, unit-testable.

import type { RpcMessage, RpcError } from './plugins'

export interface RpcToken {
  isCancelled: boolean
  onCancel: (callback: () => void) => void
}

export interface StreamRequestHandle {
  done: Promise<void>
  cancel: () => void
}

type RequestHandler = (
  params: unknown,
  context: { emit: (chunk: unknown) => void; token: RpcToken }
) => Promise<unknown>

// Consulted when no named handler matches — lets a transport binding route
// every unknown method through a shared dispatcher (socket server).
type FallbackHandler = (
  method: string,
  params: unknown,
  context: { emit: (chunk: unknown) => void; token: RpcToken }
) => Promise<unknown>

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onChunk?: (chunk: unknown) => void
}

class Token implements RpcToken {
  isCancelled = false
  private callbacks: (() => void)[] = []

  onCancel(callback: () => void): void {
    this.callbacks.push(callback)
  }

  cancel(): void {
    if (this.isCancelled) return
    this.isCancelled = true
    for (const callback of this.callbacks) callback()
  }
}

export class RpcEndpoint {
  private post: (message: RpcMessage) => void
  private nextId: number
  private pending = new Map<number, PendingCall>()
  private handlers = new Map<string, RequestHandler>()
  private fallbackHandler: FallbackHandler | null = null
  private eventHandlers = new Map<string, (payload: unknown) => void>()
  private incomingTokens = new Map<number, Token>()

  constructor(post: (message: RpcMessage) => void, idParity: 'even' | 'odd') {
    this.post = post
    this.nextId = idParity === 'even' ? 0 : 1
  }

  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler)
  }

  setFallbackHandler(handler: FallbackHandler): void {
    this.fallbackHandler = handler
  }

  onEvent(channel: string, handler: (payload: unknown) => void): void {
    this.eventHandlers.set(channel, handler)
  }

  event(channel: string, payload: unknown): void {
    this.post({ kind: 'event', channel, payload })
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.allocateId()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ kind: 'request', id, method, params })
    })
  }

  requestStream(
    method: string,
    params: unknown,
    onChunk: (chunk: unknown) => void
  ): StreamRequestHandle {
    const id = this.allocateId()
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        onChunk
      })
    })
    this.post({ kind: 'request', id, method, params, streaming: true })
    return { done, cancel: () => this.post({ kind: 'cancel', id }) }
  }

  // Fail every in-flight outgoing call (worker died / plugin disabled).
  failAllPending(message: string): void {
    for (const call of this.pending.values()) {
      call.reject(rpcErrorToError({ message, code: 'cancelled' }))
    }
    this.pending.clear()
  }

  handleMessage(message: RpcMessage): void {
    if (message.kind === 'request') {
      void this.handleRequest(message)
      return
    }
    if (message.kind === 'cancel') {
      this.incomingTokens.get(message.id)?.cancel()
      return
    }
    if (message.kind === 'event') {
      this.eventHandlers.get(message.channel)?.(message.payload)
      return
    }
    this.handleReply(message)
  }

  private handleReply(message: RpcMessage): void {
    if (message.kind === 'stream') {
      this.pending.get(message.id)?.onChunk?.(message.chunk)
      return
    }
    if (message.kind !== 'response' && message.kind !== 'end') return
    const call = this.pending.get(message.id)
    if (!call) return
    this.pending.delete(message.id)
    if (message.error) {
      call.reject(rpcErrorToError(message.error))
      return
    }
    call.resolve(message.kind === 'response' ? message.result : undefined)
  }

  private async handleRequest(message: RpcMessage & { kind: 'request' }): Promise<void> {
    const handler = this.resolveHandler(message.method)
    if (!handler) {
      this.post({
        kind: 'response',
        id: message.id,
        error: { message: `unknown method: ${message.method}`, code: 'invalid' }
      })
      return
    }
    const token = new Token()
    this.incomingTokens.set(message.id, token)
    const emit = (chunk: unknown): void => {
      if (!token.isCancelled) this.post({ kind: 'stream', id: message.id, chunk })
    }
    try {
      const result = await handler(message.params, { emit, token })
      this.replyDone(message, token, result)
    } catch (error) {
      this.replyError(message, error as Error)
    } finally {
      this.incomingTokens.delete(message.id)
    }
  }

  private resolveHandler(method: string): RequestHandler | null {
    const named = this.handlers.get(method)
    if (named) return named
    const fallback = this.fallbackHandler
    if (!fallback) return null
    return (params, context) => fallback(method, params, context)
  }

  private replyDone(
    message: RpcMessage & { kind: 'request' },
    token: Token,
    result: unknown
  ): void {
    if (message.streaming) {
      const error: RpcError | undefined = token.isCancelled
        ? { message: 'cancelled', code: 'cancelled' }
        : undefined
      this.post({ kind: 'end', id: message.id, error })
      return
    }
    this.post({ kind: 'response', id: message.id, result })
  }

  private replyError(message: RpcMessage & { kind: 'request' }, error: Error): void {
    const rpcError: RpcError = { message: error.message, code: codeOf(error) }
    if (message.streaming) {
      this.post({ kind: 'end', id: message.id, error: rpcError })
      return
    }
    this.post({ kind: 'response', id: message.id, error: rpcError })
  }

  private allocateId(): number {
    const id = this.nextId
    this.nextId += 2
    return id
  }
}

const ERROR_CODES = new Set([
  'permission-denied',
  'cancelled',
  'invalid',
  'unsupported',
  'conflict',
  'unauthenticated'
])

function codeOf(error: Error): RpcError['code'] {
  const code = (error as { code?: string }).code
  if (code && ERROR_CODES.has(code)) return code as RpcError['code']
  return 'internal'
}

function rpcErrorToError(rpcError: RpcError): Error {
  const error = new Error(rpcError.message)
  ;(error as { code?: string }).code = rpcError.code
  return error
}
