import { describe, it, expect } from 'bun:test'
import { FrameDecoder, FrameError, encodeFrame, MAX_FRAME_BYTES } from '../sdk/src/frames'
import type { RpcMessage } from '../src/shared/plugins'

const message: RpcMessage = { kind: 'request', id: 1, method: 'a.b', params: { x: 1 } }

describe('frames codec', () => {
  it('round-trips a message', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame(message))).toEqual([message])
  })

  it('handles a message split across chunks', () => {
    const decoder = new FrameDecoder()
    const encoded = encodeFrame(message)
    expect(decoder.push(encoded.slice(0, 10))).toEqual([])
    expect(decoder.push(encoded.slice(10))).toEqual([message])
  })

  it('handles multiple messages in one chunk', () => {
    const decoder = new FrameDecoder()
    const second: RpcMessage = { kind: 'response', id: 1, result: 'ok' }
    const decoded = decoder.push(encodeFrame(message) + encodeFrame(second))
    expect(decoded).toEqual([message, second])
  })

  it('survives a utf-8 sequence split across byte chunks', () => {
    const decoder = new FrameDecoder()
    const utf8Message: RpcMessage = { kind: 'request', id: 3, method: 'a.b', params: { s: 'héllo…' } }
    const bytes = new TextEncoder().encode(encodeFrame(utf8Message))
    // Split inside the multi-byte '…' sequence.
    const splitAt = bytes.length - 3
    expect(decoder.push(bytes.slice(0, splitAt))).toEqual([])
    expect(decoder.push(bytes.slice(splitAt))).toEqual([utf8Message])
  })

  it('ignores blank lines', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push('\n\n' + encodeFrame(message))).toEqual([message])
  })

  it('throws on malformed JSON', () => {
    const decoder = new FrameDecoder()
    expect(() => decoder.push('not json\n')).toThrow(FrameError)
  })

  it('throws on non-object frames', () => {
    const decoder = new FrameDecoder()
    expect(() => decoder.push('[1,2]\n')).toThrow(FrameError)
  })

  it('throws on frames missing kind', () => {
    const decoder = new FrameDecoder()
    expect(() => decoder.push('{"id":1}\n')).toThrow(FrameError)
  })

  it('throws on oversized frames', () => {
    const decoder = new FrameDecoder()
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1)
    expect(() => decoder.push(huge)).toThrow(FrameError)
  })
})
