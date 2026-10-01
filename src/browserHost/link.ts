// The host's connection to Grove, and the relay across it.
//
// Chrome can't open Grove's socket, so the extension talks to this host over
// native messaging and the host talks to Grove. The host owns the socket and
// the pairing: it reads Grove's discovery file, says `api.hello` as the
// browser extension with the `browser.provide` scope, and keeps the token it
// is given. Once paired it relays RpcMessages both ways untouched, so the
// extension speaks the provider protocol (neoworks-dev/grove#353) itself.
//
// Host ↔ extension messages:
//   host → extension  { type: 'status', state, detail? }   how the link is
//                     { type: 'rpc', message }             a frame from Grove
//   extension → host  { type: 'rpc', message }             a frame for Grove
//                     { type: 'pair' }                     pair now (prompts in Grove)
//                     { type: 'status' }                   say the state again
//
// While Grove isn't running the host stays up and retries, so the extension
// can say so instead of showing an error.

import { connect, type Socket } from 'net'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { FrameDecoder, MAX_FRAME_BYTES, encodeFrame } from '../../sdk/src/frames'
import type { HelloParams, HelloResult, RpcError, RpcMessage } from '../../sdk/src/protocol'
import { MAX_TO_BROWSER_BYTES, nativeMessageSize } from './nativeMessaging'

/** The app the extension pairs as. */
export const EXTENSION_APP_ID = 'browser-extension'
const EXTENSION_APP_NAME = 'Grove browser extension'
const EXTENSION_APP_VERSION = '1.0.0'

// The handshake's request id. Clients own odd ids; the extension starts its
// own above this, and the handshake is over before it sends any.
const HELLO_ID = 1
const DEFAULT_RETRY_MS = 2000

/**
 * How the link to Grove is.
 * - `grove-down`: no Grove to reach; retrying.
 * - `needs-pairing`: Grove is up but the host has no token; waiting for `pair`.
 * - `pairing`: asked Grove to pair; the user approves it in Grove.
 * - `connecting`: saying hello with the token it has.
 * - `connected`: paired; frames are relayed.
 */
export type LinkState = 'grove-down' | 'needs-pairing' | 'pairing' | 'connecting' | 'connected'

export interface StatusMessage {
  type: 'status'
  state: LinkState
  detail?: string
}

export interface RpcRelayMessage {
  type: 'rpc'
  message: RpcMessage
}

export type ToBrowserMessage = StatusMessage | RpcRelayMessage
export type FromBrowserMessage = RpcRelayMessage | { type: 'pair' } | { type: 'status' }

export interface LinkOptions {
  /** Grove's `grove-api.json`, which names its socket. */
  discoveryPath: string
  /** Where the pairing token is kept. */
  tokenPath: string
  /** Sends one message to the extension. */
  toBrowser: (message: ToBrowserMessage) => void
  retryMs?: number
  log?: (line: string) => void
}

/** One handshake in flight: settles with Grove's answer to `api.hello`. */
interface Handshake {
  resolve: (result: HelloResult) => void
  reject: (error: RpcError) => void
}

/** The host's link to Grove: connects, pairs, relays, and retries while Grove is down. */
export class GroveLink {
  private options: LinkOptions
  private retryMs: number
  private state: LinkState = 'grove-down'
  private detail = ''
  private socket: Socket | null = null
  private handshake: Handshake | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: LinkOptions) {
    this.options = options
    this.retryMs = DEFAULT_RETRY_MS
    if (options.retryMs !== undefined) this.retryMs = options.retryMs
  }

  /** Starts connecting, and says the state it starts in. */
  start(): void {
    this.announce()
    void this.reconnect()
  }

  /** Closes the link for good. */
  stop(): void {
    this.stopped = true
    this.clearRetry()
    this.socket?.destroy()
    this.socket = null
  }

  /** Handles one message from the extension. */
  fromBrowser(message: FromBrowserMessage): void {
    if (message.type === 'status') {
      this.announce()
      return
    }
    if (message.type === 'pair') {
      void this.pair()
      return
    }
    if (message.type === 'rpc') this.toGrove(message.message)
  }

  // ── Connecting ──────────────────────────────────────────────────

  /** Connects with the stored token, or waits to be told to pair when there is none. */
  private async reconnect(): Promise<void> {
    this.clearRetry()
    if (this.stopped || this.socket) return
    const socketPath = this.socketPath()
    if (!socketPath) {
      this.setState('grove-down')
      this.scheduleRetry()
      return
    }
    const token = this.readToken()
    if (!token) {
      // Pairing prompts in Grove, so it waits for the user to ask for it.
      this.setState('needs-pairing', this.pairingDetail())
      this.scheduleRetry()
      return
    }
    await this.open(socketPath, token)
  }

  /** Pairs now, on the user's word: says hello without a token, which prompts in Grove. */
  private async pair(): Promise<void> {
    if (this.socket) return
    this.clearRetry()
    const socketPath = this.socketPath()
    if (!socketPath) {
      this.setState('grove-down')
      this.scheduleRetry()
      return
    }
    await this.open(socketPath, undefined)
  }

  /** Dials Grove and says hello; connected once Grove answers. */
  private async open(socketPath: string, token: string | undefined): Promise<void> {
    if (token) this.setState('connecting')
    if (!token) this.setState('pairing')
    let socket: Socket
    try {
      socket = await dial(socketPath)
    } catch {
      this.setState('grove-down')
      this.scheduleRetry()
      return
    }
    if (this.stopped) {
      socket.destroy()
      return
    }
    this.socket = socket
    this.listen(socket)
    try {
      const result = await this.hello(socket, token)
      if (result.token) this.saveToken(result.token)
      this.setState('connected')
    } catch (error) {
      this.helloFailed(socket, error as RpcError, token)
    }
  }

  /** Sends `api.hello` and resolves with Grove's answer. */
  private hello(socket: Socket, token: string | undefined): Promise<HelloResult> {
    const params: HelloParams = {
      appId: EXTENSION_APP_ID,
      name: EXTENSION_APP_NAME,
      version: EXTENSION_APP_VERSION,
      requestedScopes: ['browser.provide']
    }
    if (token) params.token = token
    return new Promise((resolve, reject) => {
      this.handshake = { resolve, reject }
      socket.write(encodeFrame({ kind: 'request', id: HELLO_ID, method: 'api.hello', params }))
    })
  }

  /** After a refused or broken hello: back to waiting for pairing, or for Grove. */
  private helloFailed(socket: Socket, error: RpcError, token: string | undefined): void {
    socket.destroy()
    if (this.socket === socket) this.socket = null
    if (error.code === 'unauthenticated') {
      // The user declined, so the token is no good either.
      if (token) this.forgetToken()
      this.setState('needs-pairing', 'Grove declined the pairing.')
      this.scheduleRetry()
      return
    }
    if (!token) {
      this.setState('needs-pairing', `Pairing did not finish: ${error.message}`)
      this.scheduleRetry()
      return
    }
    this.setState('grove-down', error.message)
    this.scheduleRetry()
  }

  /** Reads Grove's frames off the socket, and notices when it goes. */
  private listen(socket: Socket): void {
    const decoder = new FrameDecoder()
    socket.on('data', (data) => {
      let messages: RpcMessage[]
      try {
        messages = decoder.push(data)
      } catch (error) {
        this.log(`grove sent a broken frame: ${(error as Error).message}`)
        socket.destroy()
        return
      }
      for (const message of messages) this.fromGrove(message)
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.closed(socket))
  }

  /** The socket closed: Grove quit, or refused us. Retries either way. */
  private closed(socket: Socket): void {
    if (this.socket !== socket) return
    this.socket = null
    const handshake = this.handshake
    this.handshake = null
    if (handshake) {
      handshake.reject({ message: 'Grove closed the connection', code: 'internal' })
      return
    }
    this.setState('grove-down')
    this.scheduleRetry()
  }

  // ── Relaying ────────────────────────────────────────────────────

  /** One frame from Grove: the handshake's answer, or something for the extension. */
  private fromGrove(message: RpcMessage): void {
    if (this.handshake && message.kind === 'response' && message.id === HELLO_ID) {
      const handshake = this.handshake
      this.handshake = null
      if (message.error) {
        handshake.reject(message.error)
        return
      }
      handshake.resolve(message.result as HelloResult)
      return
    }
    if (this.state !== 'connected') return
    const relayed: RpcRelayMessage = { type: 'rpc', message }
    if (nativeMessageSize(relayed) <= MAX_TO_BROWSER_BYTES) {
      this.options.toBrowser(relayed)
      return
    }
    // Chrome would drop the whole connection over it, so Grove hears no instead.
    if (message.kind === 'request') {
      this.writeToGrove({
        kind: 'response',
        id: message.id,
        error: { message: `${message.method} is larger than Chrome accepts from Grove (1 MB).`, code: 'invalid' }
      })
      return
    }
    this.log(`dropped a ${message.kind} too large for Chrome`)
  }

  /** One frame from the extension, for Grove; refused while not connected. */
  private toGrove(message: RpcMessage): void {
    if (this.state !== 'connected' || !this.socket) {
      this.refuseOffline(message)
      return
    }
    if (Buffer.byteLength(encodeFrame(message), 'utf8') <= MAX_FRAME_BYTES) {
      this.writeToGrove(message)
      return
    }
    // Grove would close the connection over a frame this large.
    if (message.kind === 'response') {
      this.writeToGrove({ kind: 'response', id: message.id, error: tooLargeError() })
      return
    }
    if (message.kind === 'request') {
      this.options.toBrowser({ type: 'rpc', message: { kind: 'response', id: message.id, error: tooLargeError() } })
      return
    }
    this.log(`dropped a ${message.kind} too large for Grove`)
  }

  /** Answers the extension's request when there is no Grove to send it to. */
  private refuseOffline(message: RpcMessage): void {
    if (message.kind !== 'request') return
    this.options.toBrowser({
      type: 'rpc',
      message: { kind: 'response', id: message.id, error: { message: 'Grove isn’t connected.', code: 'internal' } }
    })
  }

  /** Writes one frame to Grove's socket. */
  private writeToGrove(message: RpcMessage): void {
    this.socket?.write(encodeFrame(message))
  }

  // ── State ───────────────────────────────────────────────────────

  /** Moves to a state, telling the extension when it changed. */
  private setState(state: LinkState, detail = ''): void {
    if (this.state === state && this.detail === detail) return
    this.state = state
    this.detail = detail
    this.announce()
  }

  /** Tells the extension the current state. */
  private announce(): void {
    const status: StatusMessage = { type: 'status', state: this.state }
    if (this.detail) status.detail = this.detail
    this.options.toBrowser(status)
  }

  /** What `needs-pairing` says: why it failed last time, if it did. */
  private pairingDetail(): string {
    if (this.state === 'needs-pairing') return this.detail
    return ''
  }

  /** Tries again after the retry interval. */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.reconnect()
    }, this.retryMs)
  }

  /** Cancels a pending retry. */
  private clearRetry(): void {
    if (!this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  // ── Files ───────────────────────────────────────────────────────

  /** Grove's socket, from its discovery file; null while Grove isn't running. */
  private socketPath(): string | null {
    try {
      const discovery = JSON.parse(readFileSync(this.options.discoveryPath, 'utf8')) as { socketPath?: unknown }
      if (typeof discovery.socketPath === 'string') return discovery.socketPath
      return null
    } catch {
      return null
    }
  }

  /** The stored pairing token, or undefined when there is none. */
  private readToken(): string | undefined {
    try {
      const token = readFileSync(this.options.tokenPath, 'utf8').trim()
      if (token.length > 0) return token
      return undefined
    } catch {
      return undefined
    }
  }

  /** Keeps a freshly minted token, readable only by the user. */
  private saveToken(token: string): void {
    mkdirSync(dirname(this.options.tokenPath), { recursive: true, mode: 0o700 })
    writeFileSync(this.options.tokenPath, token, { encoding: 'utf8', mode: 0o600 })
    chmodSync(this.options.tokenPath, 0o600)
  }

  /** Drops a token Grove no longer accepts. */
  private forgetToken(): void {
    rmSync(this.options.tokenPath, { force: true })
  }

  /** Writes a line to the host's log (stderr; stdout belongs to Chrome). */
  private log(line: string): void {
    this.options.log?.(line)
  }
}

/** The error a result too large for Grove's frames becomes. */
function tooLargeError(): RpcError {
  return {
    message: `The result is larger than Grove accepts (${MAX_FRAME_BYTES / 1024 / 1024} MB). Ask for less, e.g. a clipped or jpeg screenshot.`,
    code: 'invalid'
  }
}

/** Opens a connection to a unix socket or named pipe. */
function dial(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}
