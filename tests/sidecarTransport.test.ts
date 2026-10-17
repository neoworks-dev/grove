// The sidecar's end of the wire: requests in on stdin become route calls, replies and
// pushed events come out as ndjson frames on stdout. A PassThrough stands in for the
// pipes the Rust host holds.

import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { encodeFrame } from '../sdk/src/frames'
import type { RpcMessage } from '../sdk/src/protocol'
import { StdioTransport } from '../src/main/sidecar/transport'

interface Wire {
  transport: StdioTransport
  input: PassThrough
  frames: RpcMessage[]
  logs: string[]
  ended: () => number
}

/** One line the transport wrote, as the frame it carries. */
function parseFrame(line: string): RpcMessage {
  const frame: RpcMessage = JSON.parse(line)
  return frame
}

/** A transport listening on a fake stdin, with every frame it writes and every log collected. */
function connect(): Wire {
  const frames: RpcMessage[] = []
  const logs: string[] = []
  const input = new PassThrough()
  let endedCount = 0
  const transport = new StdioTransport(
    {
      write: (chunk: string) => {
        for (const line of chunk.split('\n').filter((entry) => entry.length > 0)) {
          frames.push(parseFrame(line))
        }
      }
    },
    (message) => logs.push(message)
  )
  transport.listen(input, () => (endedCount += 1))
  return { transport, input, frames, logs, ended: () => endedCount }
}

/** Waits until the wire has written at least `count` frames. */
async function framesWritten(wire: Wire, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && wire.frames.length < count; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(wire.frames.length).toBeGreaterThanOrEqual(count)
}

describe('sidecar transport', () => {
  test('a request calls the route with its arguments and answers with the result', async () => {
    const wire = connect()
    let received: unknown[] = []
    wire.transport.handleRoute('git:branchStatus', (_event, ...args) => {
      received = args
      return { ahead: 2 }
    })
    wire.input.write(
      encodeFrame({ kind: 'request', id: 1, method: 'git:branchStatus', params: ['worktree-1', 5] })
    )
    await framesWritten(wire, 1)
    expect(received).toEqual(['worktree-1', 5])
    expect(wire.frames[0]).toEqual({ kind: 'response', id: 1, result: { ahead: 2 } })
  })

  test('a route that throws answers with its message', async () => {
    const wire = connect()
    wire.transport.handleRoute('repo:open', () => {
      throw new Error('not a git repository')
    })
    wire.input.write(encodeFrame({ kind: 'request', id: 3, method: 'repo:open', params: ['/x'] }))
    await framesWritten(wire, 1)
    expect(wire.frames[0]).toMatchObject({
      kind: 'response',
      id: 3,
      error: { message: 'not a git repository' }
    })
  })

  test('a channel nobody serves is an error that names it, as ipcMain says', async () => {
    const wire = connect()
    wire.input.write(encodeFrame({ kind: 'request', id: 1, method: 'nope:nothing', params: [] }))
    await framesWritten(wire, 1)
    expect(wire.frames[0]).toMatchObject({
      error: { message: "No handler registered for 'nope:nothing'" }
    })
  })

  test('the function handleRoute returns stops serving the channel', () => {
    const wire = connect()
    const stop = wire.transport.handleRoute('files:listDir', () => [])
    expect(wire.transport.channels()).toEqual(['files:listDir'])
    stop()
    expect(wire.transport.channels()).toEqual([])
  })

  test('a broadcast is an event frame with its payload', () => {
    const wire = connect()
    wire.transport.broadcast('event:fs-change', { relPath: 'a.txt', type: 'add' })
    expect(wire.frames).toEqual([
      { kind: 'event', channel: 'event:fs-change', payload: { relPath: 'a.txt', type: 'add' } }
    ])
  })

  test('a payload that cannot be serialised is logged and does not throw into the service', () => {
    const wire = connect()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => wire.transport.broadcast('event:bad', cyclic)).not.toThrow()
    expect(wire.frames).toEqual([])
    expect(wire.logs[0]).toContain('could not send a event frame')
  })

  test('sidecar.info lists the pid and every route being served', async () => {
    const wire = connect()
    wire.transport.handleRoute('b:two', () => 2)
    wire.transport.handleRoute('a:one', () => 1)
    wire.input.write(encodeFrame({ kind: 'request', id: 1, method: 'sidecar.info', params: null }))
    await framesWritten(wire, 1)
    expect(wire.frames[0]).toEqual({
      kind: 'response',
      id: 1,
      result: { pid: process.pid, platform: 'sidecar', channels: ['a:one', 'b:two'] }
    })
  })

  test('requests split across chunks, and several in one chunk, are all answered', async () => {
    const wire = connect()
    wire.transport.handleRoute('echo', (_event, value: number) => value)
    const first = encodeFrame({ kind: 'request', id: 1, method: 'echo', params: [1] })
    const second = encodeFrame({ kind: 'request', id: 3, method: 'echo', params: [2] })
    const joined = first + second
    wire.input.write(joined.slice(0, 10))
    wire.input.write(joined.slice(10))
    await framesWritten(wire, 2)
    const results = wire.frames.map((frame) => (frame as { result: number }).result)
    expect(results.sort((first, second) => first - second)).toEqual([1, 2])
  })

  test('a frame that is not JSON closes the transport and says so', async () => {
    const wire = connect()
    wire.input.write('this is not a frame\n')
    for (let attempt = 0; attempt < 100 && wire.ended() === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(wire.ended()).toBeGreaterThan(0)
    expect(wire.logs[0]).toContain('malformed frame')
  })

  test('the host closing the pipe ends the transport', async () => {
    const wire = connect()
    wire.input.end()
    for (let attempt = 0; attempt < 100 && wire.ended() === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(wire.ended()).toBeGreaterThan(0)
  })
})
