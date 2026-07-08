import { describe, it, expect } from 'bun:test'
import { RpcEndpoint } from '../src/renderer/src/plugins/rpc'
import type { RpcMessage } from '../src/shared/plugins'

// Wire two endpoints back to back (async delivery like postMessage).
function pair(): { host: RpcEndpoint; worker: RpcEndpoint } {
  let host: RpcEndpoint
  let worker: RpcEndpoint
  host = new RpcEndpoint((message: RpcMessage) => queueMicrotask(() => worker.handleMessage(message)), 'even')
  worker = new RpcEndpoint((message: RpcMessage) => queueMicrotask(() => host.handleMessage(message)), 'odd')
  return { host, worker }
}

describe('RpcEndpoint', () => {
  it('round-trips a request/response', async () => {
    const { host, worker } = pair()
    worker.handle('echo', async (params) => ({ got: params }))
    const result = await host.request('echo', { x: 1 })
    expect(result).toEqual({ got: { x: 1 } })
  })

  it('propagates handler errors with codes', async () => {
    const { host, worker } = pair()
    worker.handle('boom', async () => {
      const error = new Error('nope')
      ;(error as { code?: string }).code = 'permission-denied'
      throw error
    })
    await expect(host.request('boom', {})).rejects.toMatchObject({
      message: 'nope',
      code: 'permission-denied'
    })
  })

  it('rejects unknown methods', async () => {
    const { host, worker } = pair()
    void worker
    await expect(host.request('missing', {})).rejects.toMatchObject({ code: 'invalid' })
  })

  it('streams chunks then completes', async () => {
    const { host, worker } = pair()
    worker.handle('numbers', async (_params, context) => {
      context.emit([1, 2])
      context.emit([3])
      return undefined
    })
    const chunks: unknown[] = []
    const handle = host.requestStream('numbers', {}, (chunk) => chunks.push(chunk))
    await handle.done
    expect(chunks).toEqual([[1, 2], [3]])
  })

  it('cancellation reaches the handler token and ends the stream', async () => {
    const { host, worker } = pair()
    let sawCancel = false
    worker.handle('slow', async (_params, context) => {
      await new Promise<void>((resolve) => {
        context.token.onCancel(() => {
          sawCancel = true
          resolve()
        })
      })
      return undefined
    })
    const handle = host.requestStream('slow', {}, () => {})
    // Give the request a tick to arrive, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 10))
    handle.cancel()
    await expect(handle.done).rejects.toMatchObject({ code: 'cancelled' })
    expect(sawCancel).toBe(true)
  })

  it('failAllPending rejects in-flight calls', async () => {
    const { host } = pair()
    const pending = host.request('never', {})
    host.failAllPending('worker died')
    await expect(pending).rejects.toMatchObject({ message: 'worker died' })
  })

  it('events are fire-and-forget', async () => {
    const { host, worker } = pair()
    const seen: unknown[] = []
    worker.onEvent('ping', (payload) => seen.push(payload))
    host.event('ping', { a: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen).toEqual([{ a: 1 }])
  })
})
