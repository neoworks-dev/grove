// ndjson framing for RpcMessage over the local socket transport: one JSON
// message per newline-terminated line. Lives in the SDK so the node client
// and the Grove host share one codec. Text only — the protocol has no binary
// payloads — with a hard per-line cap so a misbehaving peer can't balloon
// memory.

import type { RpcMessage } from './protocol'

export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export class FrameError extends Error {}

export function encodeFrame(message: RpcMessage): string {
  return JSON.stringify(message) + '\n'
}

export class FrameDecoder {
  private buffer = ''
  // Persistent decoder so multi-byte utf-8 sequences split across chunks
  // survive ({ stream: true } keeps partial sequences buffered).
  private textDecoder = new TextDecoder()

  // Feed raw socket bytes; returns every complete message. Throws FrameError
  // on oversized or malformed lines — the connection should be destroyed.
  push(data: Uint8Array | string): RpcMessage[] {
    if (typeof data === 'string') this.buffer += data
    else this.buffer += this.textDecoder.decode(data, { stream: true })
    if (this.buffer.length > MAX_FRAME_BYTES) {
      throw new FrameError('frame exceeds maximum size')
    }
    const messages: RpcMessage[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length > 0) messages.push(decodeLine(line))
      newline = this.buffer.indexOf('\n')
    }
    return messages
  }
}

function decodeLine(line: string): RpcMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new FrameError('malformed frame: not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrameError('malformed frame: not an object')
  }
  const kind = (parsed as { kind?: unknown }).kind
  if (typeof kind !== 'string') {
    throw new FrameError('malformed frame: missing kind')
  }
  return parsed as RpcMessage
}
