// The Debug Adapter Protocol's wire format over one pair of streams: an
// adapter's stdio, or a socket to an adapter running as a server. Messages are
// JSON framed by a `Content-Length` header, the same framing LSP uses.
// Requests go both ways: the adapter asks the client for things too
// (`runInTerminal`, `startDebugging`), answered through `onReverseRequest`.

import type { Readable, Writable } from 'node:stream'
import type { DebugProtocol } from '@vscode/debugprotocol'

const HEADER_SEPARATOR = '\r\n\r\n'
const CONTENT_LENGTH = /Content-Length:\s*(\d+)/i

/** How long a request may wait for its response before it fails. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

type EventListener = (event: DebugProtocol.Event) => void
type ReverseRequestHandler = (command: string, args: unknown) => Promise<unknown>

interface PendingRequest {
  command: string
  resolve: (body: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** Thrown when an adapter answers a request with `success: false`. */
export class DapRequestError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message)
    this.name = 'DapRequestError'
  }
}

export class DapConnection {
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, PendingRequest>()
  private eventListeners = new Set<EventListener>()
  private closeListeners = new Set<() => void>()
  private reverseRequestHandler: ReverseRequestHandler | null = null
  private closed = false

  constructor(
    input: Readable,
    private output: Writable
  ) {
    input.on('data', (chunk: Buffer) => this.receive(chunk))
    input.on('close', () => this.close())
    input.on('error', () => this.close())
    output.on('error', () => this.close())
  }

  /** Sends a request and resolves with its response's body. */
  request<Body = unknown>(
    command: string,
    args?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<Body> {
    if (this.closed) {
      return Promise.reject(new DapRequestError(command, 'debug adapter is not connected'))
    }
    const seq = this.nextSequence()
    return new Promise<Body>((resolve, reject) => {
      const pending: PendingRequest = {
        command,
        resolve: resolve as (body: unknown) => void,
        reject,
        timer: null
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(seq)
          reject(new DapRequestError(command, `${command} timed out`))
        }, timeoutMs)
      }
      this.pending.set(seq, pending)
      this.write({ seq, type: 'request', command, arguments: args })
    })
  }

  /** Listens for every event the adapter sends. Returns the unsubscribe. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Called once when the connection goes away, from either side. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Answers the requests the adapter sends the client. Unhandled ones fail. */
  onReverseRequest(handler: ReverseRequestHandler): void {
    this.reverseRequestHandler = handler
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Fails every request still waiting and tells the listeners it is over. */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.reject(new DapRequestError(pending.command, 'debug adapter disconnected'))
    }
    this.pending.clear()
    for (const listener of this.closeListeners) {
      listener()
    }
    this.closeListeners.clear()
    this.eventListeners.clear()
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) {
      return
    }
    const json = JSON.stringify(message)
    const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}${HEADER_SEPARATOR}`
    this.output.write(header + json)
  }

  /** Appends a chunk and dispatches every complete message it finishes. */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let message = this.takeMessage()
    while (message !== null) {
      this.dispatch(message)
      message = this.takeMessage()
    }
  }

  /** Cuts one framed message off the front of the buffer, or null if none is whole yet. */
  private takeMessage(): DebugProtocol.ProtocolMessage | null {
    const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR)
    if (headerEnd < 0) {
      return null
    }
    const header = this.buffer.subarray(0, headerEnd).toString('ascii')
    const match = CONTENT_LENGTH.exec(header)
    const bodyStart = headerEnd + HEADER_SEPARATOR.length
    if (!match) {
      // A header without a length cannot be framed; drop it and resynchronise.
      this.buffer = this.buffer.subarray(bodyStart)
      return null
    }
    const length = Number(match[1])
    if (this.buffer.length < bodyStart + length) {
      return null
    }
    const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
    this.buffer = this.buffer.subarray(bodyStart + length)
    try {
      const message: DebugProtocol.ProtocolMessage = JSON.parse(body)
      return message
    } catch {
      return null
    }
  }

  private dispatch(message: DebugProtocol.ProtocolMessage): void {
    if (message.type === 'response') {
      this.settle(message as DebugProtocol.Response)
      return
    }
    if (message.type === 'event') {
      for (const listener of this.eventListeners) {
        listener(message as DebugProtocol.Event)
      }
      return
    }
    if (message.type === 'request') {
      void this.answer(message as DebugProtocol.Request)
    }
  }

  private settle(response: DebugProtocol.Response): void {
    const pending = this.pending.get(response.request_seq)
    if (!pending) {
      return
    }
    this.pending.delete(response.request_seq)
    if (pending.timer) {
      clearTimeout(pending.timer)
    }
    if (response.success) {
      pending.resolve(response.body)
      return
    }
    pending.reject(new DapRequestError(response.command, errorMessageOf(response)))
  }

  /** Runs a reverse request through the handler and sends its answer back. */
  private async answer(request: DebugProtocol.Request): Promise<void> {
    const reply = {
      seq: 0,
      type: 'response',
      request_seq: request.seq,
      command: request.command
    }
    if (!this.reverseRequestHandler) {
      this.write({ ...reply, seq: this.nextSequence(), success: false, message: 'not supported' })
      return
    }
    try {
      const body = await this.reverseRequestHandler(request.command, request.arguments)
      this.write({ ...reply, seq: this.nextSequence(), success: true, body })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.write({ ...reply, seq: this.nextSequence(), success: false, message })
    }
  }
}

/** The readable reason an adapter gave for a failed request. */
export function errorMessageOf(response: DebugProtocol.Response): string {
  const body = response.body as DebugProtocol.ErrorResponse['body'] | undefined
  const detail = body?.error
  if (detail && typeof detail.format === 'string') {
    return formatErrorDetail(detail)
  }
  if (response.message) {
    return response.message
  }
  return `${response.command} failed`
}

/** Fills an adapter error's `{name}` placeholders from its variables. */
function formatErrorDetail(detail: DebugProtocol.Message): string {
  const variables = detail.variables || {}
  return detail.format.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (name in variables) {
      return variables[name]
    }
    return placeholder
  })
}
