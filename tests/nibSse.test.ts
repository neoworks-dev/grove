import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { readSse, type SseFrame } from '../src/main/nib/sse'

/** Feed a raw SSE body through the parser, split into arbitrary chunks. */
async function parse(chunks: string[]): Promise<SseFrame[]> {
  const stream = Readable.from(chunks)
  const frames: SseFrame[] = []
  for await (const frame of readSse(stream)) frames.push(frame)
  return frames
}

describe('readSse', () => {
  test('reads a named frame with its sequence id', async () => {
    const frames = await parse(['id: 7\nevent: agent.message_delta\ndata: {"text":"hi"}\n\n'])
    expect(frames).toEqual([
      { id: '7', event: 'agent.message_delta', data: '{"text":"hi"}' }
    ])
  })

  test('joins multi-line data with newlines', async () => {
    const frames = await parse(['event: session.notice\ndata: one\ndata: two\n\n'])
    expect(frames[0].data).toBe('one\ntwo')
  })

  test('ignores keepalive comments', async () => {
    const frames = await parse([': keepalive\n\n', 'id: 1\nevent: session.status_idle\ndata: {}\n\n'])
    expect(frames).toHaveLength(1)
    expect(frames[0].event).toBe('session.status_idle')
  })

  test('reassembles a frame split across chunks', async () => {
    const frames = await parse(['id: 3\neve', 'nt: agent.tool_use\nda', 'ta: {"a":1}\n', '\n'])
    expect(frames).toEqual([{ id: '3', event: 'agent.tool_use', data: '{"a":1}' }])
  })

  test('reads several frames from one chunk', async () => {
    const frames = await parse([
      'id: 1\nevent: a\ndata: 1\n\nid: 2\nevent: b\ndata: 2\n\n'
    ])
    expect(frames.map((frame) => frame.event)).toEqual(['a', 'b'])
    expect(frames.map((frame) => frame.id)).toEqual(['1', '2'])
  })

  test('tolerates CRLF line endings', async () => {
    const frames = await parse(['id: 9\r\nevent: session.error\r\ndata: boom\r\n\r\n'])
    expect(frames).toEqual([{ id: '9', event: 'session.error', data: 'boom' }])
  })

  test('drops an unterminated trailing frame rather than emitting a partial one', async () => {
    const frames = await parse(['id: 1\nevent: a\ndata: 1\n\nid: 2\nevent: b\ndata: incomp'])
    expect(frames.map((frame) => frame.event)).toEqual(['a'])
  })
})
