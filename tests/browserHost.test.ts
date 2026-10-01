// The Chrome extension's native-messaging host (#358): Chrome's length-prefixed
// framing, and the link that pairs with Grove over the real API socket and
// relays the provider protocol between the extension and Grove.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MAX_FRAME_BYTES } from '../sdk/src/frames'
import type { RpcMessage } from '../sdk/src/protocol'
import { GroveLink, type StatusMessage, type ToBrowserMessage } from '../src/browserHost/link'
import {
  MAX_TO_BROWSER_BYTES,
  NativeMessageDecoder,
  NativeMessageError,
  encodeNativeMessage
} from '../src/browserHost/nativeMessaging'
import type { PermissionBroker } from '../src/main/api/broker'
import { ApiDispatcher } from '../src/main/api/dispatcher'
import { RouteRegistry } from '../src/main/api/registry'
import { registerBrowserRoutes } from '../src/main/api/routes/browser'
import { AppPairing } from '../src/main/api/socket/pairing'
import { ApiSocketServer } from '../src/main/api/socket/server'
import { BrowserProviderService } from '../src/main/browserProviders'
import type { Worktree } from '../src/shared/types'

const maybe = process.platform === 'win32' ? describe.skip : describe

const WORKTREE = '/repo/worktree'
const worktrees: Worktree[] = [
  {
    id: WORKTREE,
    name: 'worktree',
    path: WORKTREE,
    branch: 'feature',
    isMain: false,
    isDetached: false,
    locked: false,
    dirty: false,
    portSlot: 1
  }
]

describe('native-messaging framing', () => {
  test('a message is its length as a little-endian uint32, then its JSON', () => {
    const encoded = encodeNativeMessage({ type: 'pair' })
    const json = '{"type":"pair"}'
    expect(encoded.readUInt32LE(0)).toBe(json.length)
    expect(encoded.subarray(4).toString('utf8')).toBe(json)
  })

  test('messages split across chunks, and several in one chunk, come out whole', () => {
    const first = { type: 'rpc', message: { kind: 'event', channel: 'x', payload: 'ünïcode' } }
    const second = { type: 'status' }
    const stream = Buffer.concat([encodeNativeMessage(first), encodeNativeMessage(second)])
    const decoder = new NativeMessageDecoder()
    const received: unknown[] = []
    for (let offset = 0; offset < stream.length; offset += 3) {
      received.push(...decoder.push(stream.subarray(offset, offset + 3)))
    }
    expect(received).toEqual([first, second])
    expect(new NativeMessageDecoder().push(stream)).toEqual([first, second])
  })

  test('a length larger than Chrome ever sends is a broken stream', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(0xffffffff, 0)
    expect(() => new NativeMessageDecoder().push(header)).toThrow(NativeMessageError)
  })
})

let directory: string
let discoveryPath: string
let tokenPath: string
let server: ApiSocketServer | null
let providers: BrowserProviderService
let pairingRequests: number
let approvePairing: boolean
let links: GroveLink[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grove-browser-host-'))
  discoveryPath = join(directory, 'grove-api.json')
  tokenPath = join(directory, 'browser-extension', 'token')
  server = null
  providers = new BrowserProviderService({ cdpTimeoutMs: 2000 })
  pairingRequests = 0
  approvePairing = true
  links = []
})

afterEach(async () => {
  for (const link of links) link.stop()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
})

/** Starts a Grove: the real socket server with the browser routes, writing its discovery file. */
async function startGrove(): Promise<void> {
  const registry = new RouteRegistry()
  registerBrowserRoutes(registry, { providers, worktrees: () => worktrees })
  const broker = { ensure: async () => {} } as unknown as PermissionBroker
  const dispatcher = new ApiDispatcher({ registry, broker, findWorktree: () => worktrees[0] })
  const pairing = new AppPairing(
    {
      onPairingRequest: (request) => {
        pairingRequests += 1
        queueMicrotask(() => pairing.respondPairing(request.id, approvePairing))
      }
    },
    { storePath: join(directory, 'external-apps.json') }
  )
  server = new ApiSocketServer({
    dispatcher,
    pairing,
    socketPath: join(directory, 'grove.sock'),
    discoveryPath,
    onHello: (connection) => providers.connected(connection)
  })
  await server.listen()
}

/** Stops the Grove, which removes its discovery file. */
async function stopGrove(): Promise<void> {
  await server?.close()
  server = null
}

interface FakeExtension {
  link: GroveLink
  received: ToBrowserMessage[]
  statuses: () => string[]
  rpc: () => RpcMessage[]
}

/** A link as the host runs it, with what it sends Chrome collected. */
function startLink(): FakeExtension {
  const received: ToBrowserMessage[] = []
  const link = new GroveLink({ discoveryPath, tokenPath, toBrowser: (message) => received.push(message), retryMs: 20 })
  links.push(link)
  link.start()
  return {
    link,
    received,
    statuses: () => received.filter((message) => message.type === 'status').map((message) => (message as StatusMessage).state),
    rpc: () => received.flatMap((message) => (message.type === 'rpc' ? [message.message] : []))
  }
}

/** Resolves once `condition` holds; fails the test after two seconds. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The extension pairs (the user clicks "Pair" and approves in Grove) and waits for the link. */
async function pairedExtension(): Promise<FakeExtension> {
  await startGrove()
  const extension = startLink()
  await until(() => extension.statuses().includes('needs-pairing'))
  extension.link.fromBrowser({ type: 'pair' })
  await until(() => extension.statuses().at(-1) === 'connected')
  return extension
}

/** Sends a request from the extension and resolves with Grove's response to it. */
async function request(extension: FakeExtension, id: number, method: string, params: unknown): Promise<RpcMessage> {
  extension.link.fromBrowser({ type: 'rpc', message: { kind: 'request', id, method, params } })
  let response: RpcMessage | undefined
  await until(() => {
    response = extension.rpc().find((message) => message.kind === 'response' && message.id === id)
    return response !== undefined
  })
  return response as RpcMessage
}

maybe('the link to Grove', () => {
  test('says Grove isn’t running until it is, then waits to be told to pair', async () => {
    const extension = startLink()
    await until(() => extension.statuses().length > 0)
    expect(extension.statuses()).toEqual(['grove-down'])
    await startGrove()
    await until(() => extension.statuses().includes('needs-pairing'))
    expect(pairingRequests).toBe(0)
  })

  test('pairs when told to, and keeps the token where only the user can read it', async () => {
    const extension = await pairedExtension()
    expect(extension.statuses()).toEqual(['grove-down', 'needs-pairing', 'pairing', 'connected'])
    expect(pairingRequests).toBe(1)
    expect(readFileSync(tokenPath, 'utf8').length).toBeGreaterThan(20)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(providers.hasProvider()).toBe(true)
  })

  test('with a token, it connects without asking again', async () => {
    const first = await pairedExtension()
    first.link.stop()
    const second = startLink()
    await until(() => second.statuses().at(-1) === 'connected')
    expect(second.statuses()).toEqual(['grove-down', 'connecting', 'connected'])
    expect(pairingRequests).toBe(1)
  })

  test('a declined pairing goes back to needing it, and says why', async () => {
    approvePairing = false
    await startGrove()
    const extension = startLink()
    await until(() => extension.statuses().includes('needs-pairing'))
    extension.link.fromBrowser({ type: 'pair' })
    await until(() => extension.statuses().at(-1) === 'needs-pairing')
    const last = extension.received.filter((message) => message.type === 'status').at(-1) as StatusMessage
    expect(last.detail).toBe('Grove declined the pairing.')
    expect(existsSync(tokenPath)).toBe(false)
  })

  test('when Grove quits it says so, and reconnects once Grove is back', async () => {
    const extension = await pairedExtension()
    await stopGrove()
    await until(() => extension.statuses().at(-1) === 'grove-down')
    await startGrove()
    await until(() => extension.statuses().at(-1) === 'connected')
    expect(pairingRequests).toBe(1)
  })

  test('a request while Grove is down is answered with an error, not dropped', async () => {
    const extension = startLink()
    await until(() => extension.statuses().length > 0)
    const response = await request(extension, 3, 'browser.worktrees', {})
    expect(response).toMatchObject({ kind: 'response', id: 3, error: { message: 'Grove isn’t connected.' } })
  })
})

maybe('relaying the provider protocol', () => {
  test('the extension’s requests reach Grove, and Grove’s answers come back', async () => {
    const extension = await pairedExtension()
    const listed = await request(extension, 3, 'browser.worktrees', {})
    expect(listed).toEqual({
      kind: 'response',
      id: 3,
      result: [{ id: WORKTREE, name: 'worktree', branch: 'feature', path: WORKTREE }]
    })
    await request(extension, 5, 'browser.provide', { worktreeId: WORKTREE, tab: { url: 'http://localhost:3100/', title: 'Demo' } })
    expect(providers.location(WORKTREE)).toEqual({ url: 'http://localhost:3100/', title: 'Demo' })
  })

  test('Grove’s commands reach the extension, and its results go back to Grove', async () => {
    const extension = await pairedExtension()
    await request(extension, 3, 'browser.provide', { worktreeId: WORKTREE, tab: { url: 'http://x/', title: '' } })
    const result = providers.cdp(WORKTREE, 'Runtime.evaluate', { expression: '1 + 1' })
    let command: RpcMessage | undefined
    await until(() => {
      command = extension.rpc().find((message) => message.kind === 'request' && message.method === 'browser.cdp')
      return command !== undefined
    })
    const sent = command as Extract<RpcMessage, { kind: 'request' }>
    expect(sent.params).toEqual({ worktreeId: WORKTREE, method: 'Runtime.evaluate', params: { expression: '1 + 1' } })
    extension.link.fromBrowser({ type: 'rpc', message: { kind: 'response', id: sent.id, result: { result: { value: 2 } } } })
    expect(await result).toEqual({ result: { value: 2 } })
  })

  test('the extension’s CDP events feed Grove’s logs', async () => {
    const extension = await pairedExtension()
    await request(extension, 3, 'browser.provide', { worktreeId: WORKTREE, tab: { url: 'http://x/', title: '' } })
    extension.link.fromBrowser({
      type: 'rpc',
      message: {
        kind: 'event',
        channel: 'browser.cdpEvent',
        payload: { worktreeId: WORKTREE, method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'hi' }] } }
      }
    })
    await until(() => providers.consoleLog(WORKTREE).length === 1)
    expect(providers.consoleLog(WORKTREE)[0].message).toBe('hi')
  })

  test('a result too large for Grove becomes an error instead of closing the connection', async () => {
    const extension = await pairedExtension()
    await request(extension, 3, 'browser.provide', { worktreeId: WORKTREE, tab: { url: 'http://x/', title: '' } })
    const result = providers.cdp(WORKTREE, 'Page.captureScreenshot', {})
    let command: RpcMessage | undefined
    await until(() => {
      command = extension.rpc().find((message) => message.kind === 'request')
      return command !== undefined
    })
    const huge = 'A'.repeat(MAX_FRAME_BYTES + 1)
    extension.link.fromBrowser({ type: 'rpc', message: { kind: 'response', id: command!.id as number, result: { data: huge } } })
    await expect(result).rejects.toThrow('larger than Grove accepts')
    expect(providers.isAttached(WORKTREE)).toBe(true)
  })

  test('a command too large for Chrome is refused back to Grove', async () => {
    const extension = await pairedExtension()
    await request(extension, 3, 'browser.provide', { worktreeId: WORKTREE, tab: { url: 'http://x/', title: '' } })
    const text = 'B'.repeat(MAX_TO_BROWSER_BYTES)
    await expect(providers.cdp(WORKTREE, 'Input.insertText', { text })).rejects.toThrow('larger than Chrome accepts')
    expect(extension.rpc().some((message) => message.kind === 'request')).toBe(false)
  })
})

maybe('the host process', () => {
  let child: ChildProcess | null = null

  afterEach(() => {
    child?.kill()
    child = null
  })

  test('speaks Chrome’s framing on stdio and pairs through to Grove', async () => {
    await startGrove()
    child = spawn(process.execPath, [join(import.meta.dir, '..', 'src', 'browserHost', 'host.ts')], {
      env: { ...process.env, GROVE_API_DISCOVERY: discoveryPath, GROVE_BROWSER_TOKEN: tokenPath },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    const decoder = new NativeMessageDecoder()
    const received: ToBrowserMessage[] = []
    child.stdout!.on('data', (chunk: Buffer) => received.push(...(decoder.push(chunk) as ToBrowserMessage[])))
    const states = (): string[] => received.flatMap((message) => (message.type === 'status' ? [message.state] : []))

    await until(() => states().includes('needs-pairing'))
    child.stdin!.write(encodeNativeMessage({ type: 'pair' }))
    await until(() => states().at(-1) === 'connected')
    child.stdin!.write(encodeNativeMessage({ type: 'rpc', message: { kind: 'request', id: 3, method: 'browser.worktrees', params: {} } }))
    await until(() => received.some((message) => message.type === 'rpc'))
    expect(received.find((message) => message.type === 'rpc')).toMatchObject({
      message: { kind: 'response', id: 3, result: [{ id: WORKTREE }] }
    })

    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve))
    child.stdin!.end()
    expect(await exited).toBe(0)
  })
})
