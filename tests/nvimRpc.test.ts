import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { encode, decodeMultiStream } from '@msgpack/msgpack'
import { NvimRpc, toPlain } from '../src/main/nvimRpc'

function makeSession(): { rpc: NvimRpc; stdin: PassThrough; stdout: PassThrough } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const rpc = new NvimRpc(stdin, stdout)
  return { rpc, stdin, stdout }
}

async function readMessage(stream: PassThrough): Promise<unknown> {
  for await (const message of decodeMultiStream(stream)) {
    return message
  }
  return null
}

describe('NvimRpc', () => {
  test('request writes a framed request and resolves on response', async () => {
    const { rpc, stdin, stdout } = makeSession()
    const pending = rpc.request('nvim_eval', ['1+1'])
    const sent = (await readMessage(stdin)) as unknown[]
    expect(sent[0]).toBe(0)
    expect(sent[2]).toBe('nvim_eval')
    expect(sent[3]).toEqual(['1+1'])
    stdout.write(encode([1, sent[1], null, 2]))
    expect(await pending).toBe(2)
  })

  test('request rejects on rpc error tuple', async () => {
    const { rpc, stdin, stdout } = makeSession()
    const pending = rpc.request('nvim_command', ['bogus'])
    const sent = (await readMessage(stdin)) as unknown[]
    stdout.write(encode([1, sent[1], [0, 'E492: Not an editor command'], null]))
    await expect(pending).rejects.toThrow('E492')
  })

  test('notifications route to handler', async () => {
    const { rpc, stdout } = makeSession()
    const received: [string, unknown[]][] = []
    rpc.onNotification((method, args) => received.push([method, args]))
    stdout.write(encode([2, 'redraw', [['flush']]]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toEqual([['redraw', [['flush']]]])
  })

  test('close rejects in-flight requests', async () => {
    const { rpc } = makeSession()
    const pending = rpc.request('nvim_eval', ['1'])
    rpc.close()
    await expect(pending).rejects.toThrow('nvim exited')
  })
})

describe('toPlain', () => {
  test('converts Uint8Array to string and recurses containers', () => {
    const value = toPlain({
      list: [new TextEncoder().encode('hi'), 3],
      nested: { ok: true }
    })
    expect(value).toEqual({ list: ['hi', 3], nested: { ok: true } })
  })
})
