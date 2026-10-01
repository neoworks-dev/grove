// The DAP wire format: messages framed by Content-Length, split or joined in
// any way a pipe delivers them; responses matched to their requests; failures
// carrying the adapter's own message; and requests from the adapter answered.

import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { DapConnection, DapRequestError } from '../src/main/debug/dapConnection'

/** A connection plus the two ends a test plays the adapter on. */
function connected(): {
  connection: DapConnection
  fromAdapter: PassThrough
  toAdapter: PassThrough
  sent: unknown[]
} {
  const fromAdapter = new PassThrough()
  const toAdapter = new PassThrough()
  const sent: unknown[] = []
  toAdapter.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    const body = text.slice(text.indexOf('\r\n\r\n') + 4)
    sent.push(JSON.parse(body))
  })
  return { connection: new DapConnection(fromAdapter, toAdapter), fromAdapter, toAdapter, sent }
}

function frame(message: unknown): string {
  const json = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
}

describe('DapConnection', () => {
  test('resolves a request with its response body, however the bytes arrive', async () => {
    const { connection, fromAdapter, sent } = connected()
    const pending = connection.request('threads')
    const message = frame({
      seq: 1,
      type: 'response',
      request_seq: 1,
      command: 'threads',
      success: true,
      body: { threads: [{ id: 1, name: 'ü' }] }
    })
    fromAdapter.write(message.slice(0, 10))
    fromAdapter.write(message.slice(10, 40))
    fromAdapter.write(message.slice(40))
    expect(await pending).toEqual({ threads: [{ id: 1, name: 'ü' }] })
    expect(sent).toEqual([{ seq: 1, type: 'request', command: 'threads' }])
  })

  test('dispatches several messages from one chunk, events included', async () => {
    const { connection, fromAdapter } = connected()
    const events: string[] = []
    connection.onEvent((event) => events.push(event.event))
    const pending = connection.request('next', { threadId: 1 })
    fromAdapter.write(
      frame({ seq: 1, type: 'response', request_seq: 1, command: 'next', success: true }) +
        frame({ seq: 2, type: 'event', event: 'continued', body: { threadId: 1 } }) +
        frame({ seq: 3, type: 'event', event: 'stopped', body: { reason: 'step' } })
    )
    await pending
    expect(events).toEqual(['continued', 'stopped'])
  })

  test('rejects a failed request with the adapter formatted message', async () => {
    const { connection, fromAdapter } = connected()
    const pending = connection.request('launch')
    fromAdapter.write(
      frame({
        seq: 1,
        type: 'response',
        request_seq: 1,
        command: 'launch',
        success: false,
        message: 'failed',
        body: { error: { id: 1, format: 'File {path} not found', variables: { path: '/x.py' } } }
      })
    )
    await expect(pending).rejects.toThrow('File /x.py not found')
    await expect(pending).rejects.toBeInstanceOf(DapRequestError)
  })

  test('answers reverse requests, and fails the ones it has no handler for', async () => {
    const { connection, fromAdapter, sent } = connected()
    fromAdapter.write(frame({ seq: 7, type: 'request', command: 'runInTerminal', arguments: {} }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent[0]).toMatchObject({ type: 'response', request_seq: 7, success: false })

    connection.onReverseRequest((command) => Promise.resolve({ processId: command.length }))
    fromAdapter.write(frame({ seq: 8, type: 'request', command: 'runInTerminal', arguments: {} }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent[1]).toMatchObject({
      type: 'response',
      request_seq: 8,
      success: true,
      body: { processId: 13 }
    })
  })

  test('fails waiting requests when the adapter goes away', async () => {
    const { connection, fromAdapter } = connected()
    let closed = false
    connection.onClose(() => {
      closed = true
    })
    const pending = connection.request('evaluate')
    fromAdapter.destroy()
    await expect(pending).rejects.toThrow('debug adapter disconnected')
    expect(closed).toBe(true)
    await expect(connection.request('threads')).rejects.toThrow('not connected')
  })
})
