// Kit's side of the browser tool (#353): a fake Kit pairs over the real API
// socket, provides and withdraws tabs, answers browser.cdp and browser.open,
// and sends CDP events up; the tool drives it, and falls back to the Browser
// pane when no Kit tab serves the worktree.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { connect, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserCdpParams, BrowserOpenParams } from '../sdk/src/protocol'
import { FrameDecoder, encodeFrame } from '../sdk/src/frames'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import { kitOrPane, type PaneBrowser } from '../src/main/agents/tools/browserBackends'
import { browserTools } from '../src/main/agents/tools/browserTools'
import type { PermissionBroker } from '../src/main/api/broker'
import { ApiDispatcher } from '../src/main/api/dispatcher'
import { RouteRegistry } from '../src/main/api/registry'
import { registerBrowserRoutes } from '../src/main/api/routes/browser'
import { AppPairing } from '../src/main/api/socket/pairing'
import { ApiSocketServer } from '../src/main/api/socket/server'
import { KitBrowserService } from '../src/main/kitBrowser'
import type { ShowTarget } from '../src/shared/agents'
import type { RpcMessage } from '../src/shared/plugins'
import { RpcEndpoint } from '../src/shared/rpc'
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

let directory: string
let socketPath: string
let server: ApiSocketServer
let kit: KitBrowserService
let sockets: Socket[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grove-kit-'))
  socketPath = join(directory, 'grove.sock')
  sockets = []
  kit = new KitBrowserService({ cdpTimeoutMs: 2000 })
  server = buildServer()
  await server.listen()
})

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

/** The real socket server with only the browser routes, approving every pairing and scope. */
function buildServer(): ApiSocketServer {
  const registry = new RouteRegistry()
  registerBrowserRoutes(registry, { kit, worktrees: () => worktrees })
  const broker = { ensure: async () => {} } as unknown as PermissionBroker
  const dispatcher = new ApiDispatcher({ registry, broker, findWorktree: () => worktrees[0] })
  const pairing = new AppPairing(
    { onPairingRequest: (request) => queueMicrotask(() => pairing.respondPairing(request.id, true)) },
    { storePath: join(directory, 'external-apps.json') }
  )
  return new ApiSocketServer({
    dispatcher,
    pairing,
    socketPath,
    discoveryPath: null,
    onHello: (connection) => kit.connected(connection)
  })
}

interface FakeKit {
  endpoint: RpcEndpoint
  socket: Socket
  cdpCalls: BrowserCdpParams[]
  openCalls: BrowserOpenParams[]
}

/**
 * A Kit connected and paired over the socket, answering `browser.cdp` with
 * `answer`, and `browser.open` with `open`.
 */
async function connectKit(
  answer: (call: BrowserCdpParams) => unknown = () => ({}),
  open: (fake: FakeKit, call: BrowserOpenParams) => Promise<unknown> = async () => {
    throw new Error('Kit cannot open tabs here')
  }
): Promise<FakeKit> {
  const socket = connect(socketPath)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const decoder = new FrameDecoder()
  const endpoint = new RpcEndpoint((message: RpcMessage) => socket.write(encodeFrame(message)), 'odd')
  socket.on('data', (data) => {
    for (const message of decoder.push(data)) endpoint.handleMessage(message)
  })
  const fake: FakeKit = { endpoint, socket, cdpCalls: [], openCalls: [] }
  endpoint.handle('browser.cdp', async (params) => {
    fake.cdpCalls.push(params as BrowserCdpParams)
    return answer(params as BrowserCdpParams)
  })
  endpoint.handle('browser.open', async (params) => {
    fake.openCalls.push(params as BrowserOpenParams)
    return open(fake, params as BrowserOpenParams)
  })
  await endpoint.request('api.hello', {
    appId: 'kit',
    name: 'Kit',
    version: '1.0.0',
    requestedScopes: ['browser.provide']
  })
  await until(() => kit.hasProvider())
  return fake
}

/** Has the fake Kit serve the worktree with a tab. */
async function provide(fake: FakeKit, url = 'http://localhost:3100/', title = 'Demo'): Promise<void> {
  await fake.endpoint.request('browser.provide', { worktreeId: WORKTREE, tab: { url, title } })
}

/** Resolves once `condition` holds; fails the test after a second. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface FakePane extends PaneBrowser {
  sent: string[]
}

/** A Browser pane that attaches when shown if `opens`, answering every command with `{}`. */
function fakePane(opens: boolean): FakePane {
  let attached = false
  const pane: FakePane = {
    sent: [],
    isAttached: () => attached,
    waitForAttach: async () => {
      attached = opens
      return attached
    },
    location: () => ({ url: 'http://pane/', title: 'Pane' }),
    cdp: async (_worktreeId, method) => {
      pane.sent.push(method)
      return {}
    },
    consoleLog: () => [],
    networkLog: () => []
  }
  return pane
}

/** The browser tool over Kit and the given pane. */
function toolOver(pane: PaneBrowser): GroveTool {
  return browserTools(kitOrPane(kit, pane), { helpersPath: join(directory, 'browser-helpers.js') })[0]
}

/** A tool context for the worktree that records what it was asked to show. */
function contextFor(shown: ShowTarget[] = []): GroveToolContext {
  return { sessionId: 's1', workspaceRoot: WORKTREE, surface: () => {}, show: (target) => shown.push(target) }
}

maybe('a Kit providing tabs', () => {
  test('lists the worktrees it can offer a tab to', async () => {
    const fake = await connectKit()
    const listed = await fake.endpoint.request('browser.worktrees', {})
    expect(listed).toEqual([{ id: WORKTREE, name: 'worktree', branch: 'feature', path: WORKTREE }])
  })

  test('provide serves the worktree, and withdraw stops it', async () => {
    const fake = await connectKit()
    await provide(fake)
    expect(kit.isAttached(WORKTREE)).toBe(true)
    expect(kit.location(WORKTREE)).toEqual({ url: 'http://localhost:3100/', title: 'Demo' })
    await fake.endpoint.request('browser.withdraw', { worktreeId: WORKTREE })
    expect(kit.isAttached(WORKTREE)).toBe(false)
  })

  test('providing an unknown worktree is refused', async () => {
    const fake = await connectKit()
    await expect(
      fake.endpoint.request('browser.provide', { worktreeId: '/elsewhere', tab: { url: 'x', title: '' } })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  test('a second Kit providing the worktree takes it over, and the first cannot withdraw it', async () => {
    const first = await connectKit(() => ({ from: 'first' }))
    const second = await connectKit(() => ({ from: 'second' }))
    await provide(first)
    await provide(second)
    await first.endpoint.request('browser.withdraw', { worktreeId: WORKTREE })
    expect(kit.isAttached(WORKTREE)).toBe(true)
    expect(await kit.cdp(WORKTREE, 'Runtime.evaluate', {})).toEqual({ from: 'second' })
  })

  test('a disconnected Kit stops serving, and its unanswered command fails', async () => {
    const fake = await connectKit(() => new Promise(() => {}))
    await provide(fake)
    const result = toolOver(fakePane(false)).execute({ method: 'Page.reload' }, contextFor())
    await until(() => fake.cdpCalls.length === 1)
    fake.socket.destroy()
    const reply = await result
    expect(reply.isError).toBe(true)
    expect(reply.content).toContain('the app disconnected')
    await until(() => !kit.isAttached(WORKTREE))
    expect(kit.hasProvider()).toBe(false)
  })
})

maybe('the tool over a Kit tab', () => {
  test('a command goes down Kit’s connection and its result comes back', async () => {
    const fake = await connectKit(() => ({ result: { type: 'number', value: 42 } }))
    await provide(fake)
    const pane = fakePane(true)
    const shown: ShowTarget[] = []
    const reply = await toolOver(pane).execute(
      { method: 'Runtime.evaluate', params: { expression: '6 * 7', returnByValue: true } },
      contextFor(shown)
    )
    expect(fake.cdpCalls).toEqual([
      { worktreeId: WORKTREE, method: 'Runtime.evaluate', params: { expression: '6 * 7', returnByValue: true } }
    ])
    expect(reply.content).toStartWith('{"result":{"type":"number","value":42}}')
    expect(reply.content).toContain('Now at http://localhost:3100/ (“Demo”)')
    expect(pane.sent).toEqual([])
    expect(shown).toEqual([])
  })

  test('Kit’s CDP error is the tool’s error', async () => {
    const fake = await connectKit((call) => {
      throw Object.assign(new Error(`'${call.method}' wasn't found`), { code: -32601 })
    })
    await provide(fake)
    const reply = await toolOver(fakePane(true)).execute({ method: 'Nope.method' }, contextFor())
    expect(reply.isError).toBe(true)
    expect(reply.content).toContain("'Nope.method' wasn't found")
  })

  test('a navigation moves where the tab is, and so does a frame navigating', async () => {
    const fake = await connectKit()
    await provide(fake)
    const tool = toolOver(fakePane(true))
    const reply = await tool.execute({ method: 'Page.navigate', params: { url: 'http://localhost:3100/about' } }, contextFor())
    expect(reply.content).toContain('Now at http://localhost:3100/about.')
    fake.endpoint.event('browser.cdpEvent', {
      worktreeId: WORKTREE,
      method: 'Page.frameNavigated',
      params: { frame: { id: 'main', url: 'http://localhost:3100/login' } }
    })
    await until(() => kit.location(WORKTREE).url === 'http://localhost:3100/login')
  })

  test('console messages and failed requests Kit sends up feed the event tail', async () => {
    const fake = await connectKit()
    await provide(fake)
    const events = [
      {
        method: 'Runtime.consoleAPICalled',
        params: {
          type: 'error',
          args: [{ type: 'string', value: 'Uncaught ReferenceError: missingFunction' }],
          stackTrace: { callFrames: [{ url: 'http://localhost:3100/app.js', lineNumber: 11 }] }
        }
      },
      { method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } } },
      { method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { method: 'POST', url: 'http://localhost:3100/api/save' } } },
      { method: 'Network.loadingFailed', params: { requestId: 'r1', type: 'Fetch', errorText: 'NS_ERROR_CONNECTION_REFUSED' } },
      { method: 'Network.responseReceived', params: { requestId: 'r2', type: 'XHR', response: { url: 'http://localhost:3100/missing.json', status: 404 } } },
      { method: 'Network.responseReceived', params: { requestId: 'r3', type: 'Document', response: { url: 'http://localhost:3100/', status: 200 } } }
    ]
    for (const event of events) fake.endpoint.event('browser.cdpEvent', { worktreeId: WORKTREE, ...event })
    await until(() => kit.networkLog(WORKTREE).length === 3)

    const tool = toolOver(fakePane(true))
    const first = await tool.execute({ method: 'Page.reload' }, contextFor())
    expect(first.content).toContain('- error: Uncaught ReferenceError: missingFunction (http://localhost:3100/app.js:12)')
    expect(first.content).toContain('- error: TypeError: x is undefined')
    expect(first.content).toContain('- POST http://localhost:3100/api/save → NS_ERROR_CONNECTION_REFUSED')
    expect(first.content).toContain('missing.json → 404')
    expect(first.content).not.toContain('http://localhost:3100/ → 200')

    const second = await tool.execute({ method: 'Page.reload' }, contextFor())
    expect(second.content).not.toContain('missingFunction')
  })

  test('events for a worktree the connection does not serve are ignored', async () => {
    const serving = await connectKit()
    const other = await connectKit()
    await provide(serving)
    other.endpoint.event('browser.cdpEvent', {
      worktreeId: WORKTREE,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ type: 'string', value: 'not mine' }] }
    })
    serving.endpoint.event('browser.cdpEvent', {
      worktreeId: WORKTREE,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ type: 'string', value: 'mine' }] }
    })
    await until(() => kit.consoleLog(WORKTREE).length > 0)
    expect(kit.consoleLog(WORKTREE).map((entry) => entry.message)).toEqual(['mine'])
  })

  test('the console log is capped', async () => {
    const fake = await connectKit()
    await provide(fake)
    for (let index = 0; index < 320; index++) {
      fake.endpoint.event('browser.cdpEvent', {
        worktreeId: WORKTREE,
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ type: 'number', value: index }] }
      })
    }
    await until(() => kit.consoleLog(WORKTREE).at(-1)?.message === '319')
    expect(kit.consoleLog(WORKTREE)).toHaveLength(300)
  })
})

maybe('opening a tab and falling back to the pane', () => {
  test('with a Kit connected and nothing serving the worktree, Kit is asked to open a tab', async () => {
    const fake = await connectKit(
      () => ({ result: { type: 'string', value: 'complete' } }),
      async (self, call) => {
        await self.endpoint.request('browser.provide', { worktreeId: call.worktreeId, tab: { url: 'about:blank', title: '' } })
        return null
      }
    )
    const pane = fakePane(true)
    const shown: ShowTarget[] = []
    const reply = await toolOver(pane).execute({ method: 'Runtime.evaluate', params: { expression: 'document.readyState' } }, contextFor(shown))
    expect(fake.openCalls).toEqual([{ worktreeId: WORKTREE }])
    expect(fake.cdpCalls.map((call) => call.method)).toEqual(['Runtime.evaluate'])
    expect(reply.content).toContain('"complete"')
    expect(shown).toEqual([])
    expect(pane.sent).toEqual([])
  })

  test('without a Kit, the tool opens the Browser pane and drives it', async () => {
    const pane = fakePane(true)
    const shown: ShowTarget[] = []
    const reply = await toolOver(pane).execute({ method: 'Page.reload' }, contextFor(shown))
    expect(shown).toEqual([{ kind: 'pane', pane: 'browser' }])
    expect(pane.sent).toEqual(['Page.reload'])
    expect(reply.content).toContain('Now at http://pane/')
  })

  test('when Kit cannot open a tab, the tool falls back to the pane', async () => {
    const fake = await connectKit()
    const pane = fakePane(true)
    const shown: ShowTarget[] = []
    await toolOver(pane).execute({ method: 'Page.reload' }, contextFor(shown))
    expect(fake.openCalls).toHaveLength(1)
    expect(shown).toEqual([{ kind: 'pane', pane: 'browser' }])
    expect(pane.sent).toEqual(['Page.reload'])
  })

  test('with neither, the agent is told to ask for a Kit tab or the pane', async () => {
    const reply = await toolOver(fakePane(false)).execute({ method: 'Page.reload' }, contextFor())
    expect(reply.isError).toBe(true)
    expect(reply.content).toContain('connect a Kit tab')
    expect(reply.content).toContain('Browser pane')
  })

  test('a Kit tab wins over an open pane', async () => {
    const pane = fakePane(true)
    await pane.waitForAttach(WORKTREE, 0)
    const fake = await connectKit(() => ({ from: 'kit' }))
    await provide(fake)
    const reply = await toolOver(pane).execute({ method: 'Runtime.evaluate' }, contextFor())
    expect(reply.content).toStartWith('{"from":"kit"}')
    expect(pane.sent).toEqual([])
  })
})
