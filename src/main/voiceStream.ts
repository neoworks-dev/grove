// One dictation's stream to Anthropic's speech-to-text endpoint, the one Claude
// Code's own /voice uses. The endpoint is internal rather than documented, so the
// framing here mirrors what Claude Code sends: linear16 PCM frames in, a KeepAlive
// every few seconds, a CloseStream to finish, and transcript messages back. When
// it changes, this is the file that breaks.
//
// The socket is passed in as an adapter so tests can drive the framing with a fake
// socket, without a network. Transcript text is kept as committed utterances plus
// the one still in progress, because the server repeats the in-progress text rather
// than appending to it.

import WebSocket, { type RawData } from 'ws'

export const VOICE_STREAM_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream'
const KEEP_ALIVE_INTERVAL_MS = 8000
// After CloseStream: give up after this long without any transcript...
const FINALIZE_NO_DATA_MS = 1500
// ...and never wait longer than this for the server to finish.
const FINALIZE_SAFETY_MS = 5000
const KEEP_ALIVE_MESSAGE = JSON.stringify({ type: 'KeepAlive' })
const CLOSE_STREAM_MESSAGE = JSON.stringify({ type: 'CloseStream' })

/** The part of a WebSocket the stream uses, once the upgrade has been accepted. */
export interface VoiceSocket {
  isOpen: () => boolean
  send: (frame: Buffer | string) => void
  close: () => void
  onMessage: (listener: (text: string) => void) => void
  onError: (listener: (message: string) => void) => void
  onClose: (listener: (code: number, reason: string) => void) => void
}

/** Opens a socket to the URL with the headers, resolving once the server accepts the upgrade. */
export type OpenVoiceSocket = (url: string, headers: Record<string, string>) => Promise<VoiceSocket>

export interface VoiceStreamOptions {
  accessToken: string
  /** The WebSocket URL to dictate to; production passes VOICE_STREAM_URL. */
  endpoint: string
  language: string
  openSocket: OpenVoiceSocket
  /** Called when the connection or server fails after the stream is open. */
  onError: (message: string) => void
}

/** Hooks the finish wait needs from the socket events that arrive while it runs. */
interface FinishListener {
  onTranscript: () => void
  onEnd: () => void
}

/** Opens a real WebSocket, resolving once the server accepts the upgrade and rejecting if it refuses. */
export function openWebSocket(url: string, headers: Record<string, string>): Promise<VoiceSocket> {
  const socket = new WebSocket(url, { headers })
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(adaptWebSocket(socket)))
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`WebSocket upgrade rejected with HTTP ${String(response.statusCode)}`))
    })
    socket.once('error', (error) => reject(error))
  })
}

/** Presents a ws WebSocket through the VoiceSocket interface. */
function adaptWebSocket(socket: WebSocket): VoiceSocket {
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (frame) => socket.send(frame),
    close: () => socket.close(),
    onMessage: (listener) => socket.on('message', (data) => listener(frameText(data))),
    onError: (listener) => socket.on('error', (error) => listener(error.message)),
    onClose: (listener) =>
      socket.on('close', (code, reason) => listener(code, reason.toString()))
  }
}

/** The URL for a dictation in one language, with the audio format the endpoint expects. */
export function buildVoiceStreamUrl(endpoint: string, language: string): string {
  const parameters = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language,
    use_conversation_engine: 'true'
  })
  return `${endpoint}?${parameters.toString()}`
}

/** Joins committed utterances and the one in progress into the transcript the user sees. */
export function joinTranscript(committed: string[], pending: string): string {
  return [...committed, pending].filter((part) => part !== '').join(' ')
}

/** One dictation: connect, stream audio, then finish to collect the final text. */
export class VoiceStream {
  private readonly options: VoiceStreamOptions
  private socket: VoiceSocket | null = null
  private keepAliveTimer: NodeJS.Timeout | null = null
  private committed: string[] = []
  private pending = ''
  private closeRequested = false
  private finishing: Promise<string> | null = null
  private finishListener: FinishListener | null = null

  constructor(options: VoiceStreamOptions) {
    this.options = options
  }

  /** Opens the socket with the sign-in in the headers, rejecting if the server refuses the upgrade. */
  async connect(): Promise<void> {
    const url = buildVoiceStreamUrl(this.options.endpoint, this.options.language)
    const headers = {
      Authorization: `Bearer ${this.options.accessToken}`,
      'User-Agent': 'grove',
      'x-app': 'cli'
    }
    const socket = await this.options.openSocket(url, headers)
    this.socket = socket
    socket.onMessage((text) => this.handleMessage(text))
    socket.onError((message) => this.options.onError(message))
    socket.onClose((code, reason) => this.handleClose(code, reason))
    this.startKeepAlive(socket)
  }

  /** Sends one chunk of 16 kHz mono linear16 audio; dropped once the stream is finishing. */
  sendAudio(chunk: Buffer): void {
    if (this.closeRequested || !this.socket?.isOpen()) return
    this.socket.send(chunk)
  }

  /** Ends the stream and resolves with the final transcript once the server has flushed its last utterance. */
  finish(): Promise<string> {
    if (this.finishing) return this.finishing
    this.closeRequested = true
    this.finishing = new Promise((resolve) => {
      this.awaitFinalUtterance(() => {
        this.promotePending()
        this.close()
        resolve(joinTranscript(this.committed, ''))
      })
      this.sendCloseStream()
    })
    return this.finishing
  }

  /** Stops the keep-alive and closes the socket without waiting for a transcript. */
  close(): void {
    this.stopKeepAlive()
    this.closeRequested = true
    if (this.socket?.isOpen()) this.socket.close()
  }

  /**
   * Waits for the server's last utterance, then calls done once. The wait ends on
   * the endpoint message, the socket closing, the safety limit, or a quiet spell
   * before any transcript arrives; transcript arriving cancels the quiet timer.
   */
  private awaitFinalUtterance(done: () => void): void {
    let quietTimer: NodeJS.Timeout | null = null
    const safetyTimer = setTimeout(() => end(), FINALIZE_SAFETY_MS)
    const end = (): void => {
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(safetyTimer)
      this.finishListener = null
      done()
    }
    quietTimer = setTimeout(() => end(), FINALIZE_NO_DATA_MS)
    this.finishListener = {
      onTranscript: (): void => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = null
      },
      onEnd: end
    }
  }

  private handleMessage(raw: string): void {
    const message = parseMessage(raw)
    if (!message) return
    switch (message.type) {
      case 'TranscriptInterim':
      case 'TranscriptText':
        if (message.data) this.pending = message.data
        this.finishListener?.onTranscript()
        return
      case 'TranscriptEndpoint':
        this.commitPending()
        this.finishListener?.onEnd()
        return
      case 'TranscriptError':
        this.promotePending()
        this.options.onError(describeFrameError(message))
        return
      case 'error':
        this.promotePending()
        this.options.onError(describeFrameError(message))
        return
      default:
        return
    }
  }

  private handleClose(code: number, reason: string): void {
    this.stopKeepAlive()
    this.promotePending()
    this.finishListener?.onEnd()
    // 1000 and 1005 are a normal close; anything else means the dictation was dropped.
    if (this.closeRequested || code === 1000 || code === 1005) return
    let message = `Connection closed: code ${code}`
    if (reason !== '') message += ` — ${reason}`
    this.options.onError(message)
  }

  private startKeepAlive(socket: VoiceSocket): void {
    this.keepAliveTimer = setInterval(() => {
      if (socket.isOpen()) socket.send(KEEP_ALIVE_MESSAGE)
    }, KEEP_ALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  private sendCloseStream(): void {
    if (this.socket?.isOpen()) this.socket.send(CLOSE_STREAM_MESSAGE)
  }

  /** Turns the in-progress utterance into a committed one, as the endpoint message does. */
  private commitPending(): void {
    if (this.pending !== '') this.committed.push(this.pending)
    this.pending = ''
  }

  /** Commits whatever is still in progress, so a dropped stream keeps the words it already has. */
  private promotePending(): void {
    if (this.pending !== '') this.commitPending()
  }
}

/** The fields of a server frame this client reads; other frame types carry none of them. */
interface ServerMessage {
  type: string
  data?: string
  description?: string
  error_code?: string
  message?: string
}

/** The text to show for an error frame: its description, else its code, else its message. */
function describeFrameError(message: ServerMessage): string {
  if (message.description) return message.description
  if (message.error_code) return message.error_code
  if (message.message) return message.message
  return 'unknown transcription error'
}

/** Parses one server frame, or returns null when it is not JSON. */
function parseMessage(raw: string): ServerMessage | null {
  try {
    const message: ServerMessage = JSON.parse(raw)
    return message
  } catch {
    return null
  }
}

/** The text of a received frame, whichever buffer shape ws delivered it in. */
function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
