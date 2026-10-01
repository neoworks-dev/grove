// Chrome's native-messaging framing: every message is UTF-8 JSON preceded by
// its length in bytes, a 32-bit unsigned integer in native byte order. Every
// platform Grove ships for is little-endian.

// Chrome refuses a message from the host larger than this.
export const MAX_TO_BROWSER_BYTES = 1024 * 1024
// Chrome never sends one larger than this; a bigger length is a broken stream.
export const MAX_FROM_BROWSER_BYTES = 64 * 1024 * 1024

const HEADER_BYTES = 4

export class NativeMessageError extends Error {}

/** One message as Chrome reads it: the length header, then the JSON. */
export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/** How many bytes a message takes on the wire to Chrome, header included. */
export function nativeMessageSize(message: unknown): number {
  return HEADER_BYTES + Buffer.byteLength(JSON.stringify(message), 'utf8')
}

/** Reassembles Chrome's messages from stdin chunks, which split them anywhere. */
export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0)

  /** Feeds raw bytes; returns every message they completed. Throws on a broken stream. */
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    let message = this.next()
    while (message !== undefined) {
      messages.push(message)
      message = this.next()
    }
    return messages
  }

  /** The next whole message off the front of the buffer, or undefined while it is incomplete. */
  private next(): unknown {
    if (this.buffer.length < HEADER_BYTES) return undefined
    const length = this.buffer.readUInt32LE(0)
    if (length > MAX_FROM_BROWSER_BYTES) {
      throw new NativeMessageError(`message of ${length} bytes is larger than Chrome sends`)
    }
    if (this.buffer.length < HEADER_BYTES + length) return undefined
    const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8')
    this.buffer = this.buffer.subarray(HEADER_BYTES + length)
    try {
      return JSON.parse(body)
    } catch {
      throw new NativeMessageError('message is not JSON')
    }
  }
}
