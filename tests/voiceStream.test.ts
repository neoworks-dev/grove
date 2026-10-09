// The voice stream's framing, driven through a fake socket that records what the
// stream sends and lets a test deliver the frames the server would send back. The
// real WebSocket adapter is only exercised in the app, since bun's ws shim does not
// implement the upgrade events it depends on.

import { describe, expect, test } from 'bun:test'
import {
  joinTranscript,
  VoiceStream,
  type OpenVoiceSocket,
  type VoiceSocket
} from '../src/main/voiceStream'

/** A socket that records what the stream sends, and lets a test deliver server frames. */
class FakeVoiceSocket implements VoiceSocket {
  sent: Array<Buffer | string> = []
  /** Runs for each frame the stream sends, so a test can answer it the way the server would. */
  onSendFrame: ((frame: Buffer | string) => void) | null = null
  #open = true
  #messageListener: ((text: string) => void) | null = null
  #errorListener: ((message: string) => void) | null = null
  #closeListener: ((code: number, reason: string) => void) | null = null

  isOpen(): boolean {
    return this.#open
  }

  send(frame: Buffer | string): void {
    this.sent.push(frame)
    this.onSendFrame?.(frame)
  }

  close(): void {
    this.#open = false
  }

  onMessage(listener: (text: string) => void): void {
    this.#messageListener = listener
  }

  onError(listener: (message: string) => void): void {
    this.#errorListener = listener
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.#closeListener = listener
  }

  /** Delivers one server frame as the endpoint would send it. */
  deliver(frame: Record<string, unknown>): void {
    this.#messageListener?.(JSON.stringify(frame))
  }

  /** Simulates the server or network failing with an error message. */
  fail(message: string): void {
    this.#errorListener?.(message)
  }

  /** Simulates the connection closing with the given code. */
  drop(code: number, reason = ''): void {
    this.#open = false
    this.#closeListener?.(code, reason)
  }
}

/** An opener that hands back the fake and records the URL and headers the stream asked for. */
function openerFor(socket: VoiceSocket): {
  open: OpenVoiceSocket
  requests: Array<{ url: string; headers: Record<string, string> }>
} {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  return {
    requests,
    open: (url, headers) => {
      requests.push({ url, headers })
      return Promise.resolve(socket)
    }
  }
}

/** Answers the stream's CloseStream with the endpoint frame that ends the last utterance. */
function endpointOnCloseStream(socket: FakeVoiceSocket): void {
  socket.onSendFrame = (frame) => {
    if (typeof frame === 'string' && frame.includes('CloseStream')) {
      socket.deliver({ type: 'TranscriptEndpoint' })
    }
  }
}

describe('VoiceStream connection', () => {
  test('opens the endpoint with the sign-in as a bearer token and the audio format in the query', async () => {
    const socket = new FakeVoiceSocket()
    const { open, requests } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token-123',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: () => {}
    })

    await stream.connect()
    stream.close()

    expect(requests).toHaveLength(1)
    const url = new URL(requests[0].url)
    expect(url.origin + url.pathname).toBe('wss://example.test/voice')
    expect(url.searchParams.get('encoding')).toBe('linear16')
    expect(url.searchParams.get('sample_rate')).toBe('16000')
    expect(url.searchParams.get('forward_interims')).toBe('typed')
    expect(requests[0].headers.Authorization).toBe('Bearer token-123')
  })

  test('rejects connect when the socket cannot be opened', async () => {
    const stream = new VoiceStream({
      accessToken: 'stale',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: () => {
        return Promise.reject(new Error('WebSocket upgrade rejected with HTTP 401'))
      },
      onError: () => {}
    })

    await expect(stream.connect()).rejects.toThrow('HTTP 401')
  })
})

describe('VoiceStream finishing', () => {
  test('streams audio, then returns the transcript the server closes after CloseStream', async () => {
    const socket = new FakeVoiceSocket()
    endpointOnCloseStream(socket)
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: () => {}
    })
    await stream.connect()

    stream.sendAudio(Buffer.from([1, 2, 3, 4]))
    socket.deliver({ type: 'TranscriptText', data: 'use the new' })
    socket.deliver({ type: 'TranscriptEndpoint' })
    socket.deliver({ type: 'TranscriptText', data: 'helper' })
    const transcript = await stream.finish()

    expect(transcript).toBe('use the new helper')
    expect(socket.sent).toContainEqual(Buffer.from([1, 2, 3, 4]))
    expect(socket.sent).toContain(JSON.stringify({ type: 'CloseStream' }))
  })

  test('drops audio sent after finish has begun', async () => {
    const socket = new FakeVoiceSocket()
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: () => {}
    })
    await stream.connect()

    const finishing = stream.finish()
    stream.sendAudio(Buffer.from([9, 9]))
    await finishing

    expect(socket.sent.some((frame) => Buffer.isBuffer(frame))).toBe(false)
  })

  test('gives up after a quiet spell when the server sends no transcript', async () => {
    const socket = new FakeVoiceSocket()
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: () => {}
    })
    await stream.connect()

    const started = Date.now()
    const transcript = await stream.finish()

    expect(transcript).toBe('')
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('VoiceStream errors', () => {
  test('a transcription error frame is reported with its description', async () => {
    const errors: string[] = []
    const socket = new FakeVoiceSocket()
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: (message) => errors.push(message)
    })
    await stream.connect()

    socket.deliver({ type: 'TranscriptError', description: 'speech model unavailable' })

    expect(errors).toEqual(['speech model unavailable'])
    stream.close()
  })

  test('a connection dropped during dictation is reported with its close code', async () => {
    const errors: string[] = []
    const socket = new FakeVoiceSocket()
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: (message) => errors.push(message)
    })
    await stream.connect()

    socket.drop(1006)

    expect(errors).toEqual(['Connection closed: code 1006'])
  })

  test('a normal close after finish is not reported as an error', async () => {
    const errors: string[] = []
    const socket = new FakeVoiceSocket()
    endpointOnCloseStream(socket)
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onError: (message) => errors.push(message)
    })
    await stream.connect()

    const finishing = stream.finish()
    socket.drop(1000)
    await finishing

    expect(errors).toEqual([])
  })
})
describe('VoiceStream live transcript', () => {
  test('reports the whole text so far as each frame arrives', async () => {
    const updates: string[] = []
    const socket = new FakeVoiceSocket()
    const { open } = openerFor(socket)
    const stream = new VoiceStream({
      accessToken: 'token',
      endpoint: 'wss://example.test/voice',
      language: 'en',
      openSocket: open,
      onTranscript: (text) => updates.push(text),
      onError: () => {}
    })
    await stream.connect()

    socket.deliver({ type: 'TranscriptText', data: 'use the' })
    socket.deliver({ type: 'TranscriptText', data: 'use the new' })
    socket.deliver({ type: 'TranscriptEndpoint' })
    socket.deliver({ type: 'TranscriptText', data: 'helper' })
    stream.close()

    expect(updates).toEqual(['use the', 'use the new', 'use the new', 'use the new helper'])
  })
})


describe('joinTranscript', () => {
  test('joins committed utterances and the one in progress with single spaces', () => {
    expect(joinTranscript(['use the', 'new helper'], 'please')).toBe('use the new helper please')
  })

  test('skips empty parts', () => {
    expect(joinTranscript([], '')).toBe('')
    expect(joinTranscript(['only this'], '')).toBe('only this')
  })
})
