// Browser tabs handed to worktrees, as agents drive them.
//
// A browser provider — Kit, Neoworks' own browser, or Chrome through Grove's
// extension and its native-messaging host — pairs with Grove over the API
// socket and hands it a tab per worktree (`browser.provide`). From then on the
// agent's browser tool sends its DevTools protocol commands down that
// provider's connection (`browser.cdp`), and the provider sends the tab's
// console and network events back up (`browser.cdpEvent`), which are kept here
// per worktree. Every provider is treated the same. The protocol is neoworks-dev/grove#353; its types are in the SDK.

import type {
  BrowserCdpEvent,
  BrowserOpenParams,
  BrowserProvideParams,
  BrowserTab
} from '../../sdk/src/protocol'
import { BROWSER_CDP_EVENT } from '../../sdk/src/protocol'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from '../shared/types'
import type { ApiConnection } from './api/registry'
import type { AgentBrowser } from './agents/tools/browserTools'

// How much of each log is kept; older entries fall off the front.
const LOG_LIMIT = 300
// How long one command may take before it is given up on: the provider is
// another process, and a tab it lost track of would otherwise hang the turn.
const CDP_TIMEOUT_MS = 30000

/** A tab a provider has handed over for a worktree, with what it logged since. */
interface ProvidedTab {
  connection: ApiConnection
  url: string
  title: string
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  // Requests the tab started, by CDP request id, so a later failure can say
  // which request it was.
  requests: Map<string, RequestStart>
}

interface RequestStart {
  method: string
  url: string
}

export interface BrowserProviderOptions {
  cdpTimeoutMs?: number
}

/** The worktrees' provided tabs, behind the browser tool's `AgentBrowser` interface. */
export class BrowserProviderService implements AgentBrowser {
  private tabs = new Map<string, ProvidedTab>()
  // Connected providers, oldest first; the newest is asked to open a tab first.
  private connections: ApiConnection[] = []
  private waiters = new Map<string, Array<() => void>>()
  private cdpTimeoutMs: number

  constructor(options: BrowserProviderOptions = {}) {
    this.cdpTimeoutMs = CDP_TIMEOUT_MS
    if (options.cdpTimeoutMs !== undefined) this.cdpTimeoutMs = options.cdpTimeoutMs
  }

  // ── Connections ─────────────────────────────────────────────────

  /**
   * Takes note of a connection that may provide tabs: listens for its events
   * and forgets its tabs when it closes. Connections without the scope, and
   * ones already known, are ignored.
   */
  connected(connection: ApiConnection): void {
    if (!connection.client.declaredScopes.includes('browser.provide')) return
    if (this.connections.includes(connection)) return
    this.connections.push(connection)
    connection.endpoint.onEvent(BROWSER_CDP_EVENT, (payload) => this.receive(connection, payload))
    connection.onClose(() => this.disconnected(connection))
  }

  /** Whether any provider is connected, whether or not it serves a worktree. */
  hasProvider(): boolean {
    return this.connections.length > 0
  }

  /** Forgets a closed connection and every tab it served. */
  private disconnected(connection: ApiConnection): void {
    this.connections = this.connections.filter((known) => known !== connection)
    for (const [worktreeId, tab] of this.tabs) {
      if (tab.connection === connection) this.tabs.delete(worktreeId)
    }
  }

  // ── Provide and withdraw ────────────────────────────────────────

  /**
   * A connection now serves a worktree, replacing whatever served it before.
   * The same connection providing again only updates the tab, and keeps its logs.
   */
  provide(connection: ApiConnection, params: BrowserProvideParams): void {
    this.connected(connection)
    const existing = this.tabs.get(params.worktreeId)
    if (existing && existing.connection === connection) {
      existing.url = params.tab.url
      existing.title = params.tab.title
      return
    }
    this.tabs.set(params.worktreeId, newTab(connection, params.tab))
    this.wakeWaiters(params.worktreeId)
  }

  /** The tab serving a worktree went away, when it is this connection's. */
  withdraw(connection: ApiConnection, worktreeId: string): void {
    const tab = this.tabs.get(worktreeId)
    if (!tab) return
    if (tab.connection !== connection) return
    this.tabs.delete(worktreeId)
  }

  // ── AgentBrowser ────────────────────────────────────────────────

  /** Whether a provided tab serves the worktree. */
  isAttached(worktreeId: string): boolean {
    return this.tabs.has(worktreeId)
  }

  /**
   * Resolves once a provided tab serves the worktree, or false after
   * `timeoutMs`; false straight away when no provider is connected.
   */
  waitForAttach(worktreeId: string, timeoutMs: number): Promise<boolean> {
    if (this.tabs.has(worktreeId)) return Promise.resolve(true)
    if (this.connections.length === 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.dropWaiter(worktreeId, wake)
        resolve(this.tabs.has(worktreeId))
      }, timeoutMs)
      const waiting = this.waiters.get(worktreeId)
      if (waiting) {
        waiting.push(wake)
        return
      }
      this.waiters.set(worktreeId, [wake])
    })
  }

  /**
   * Asks the connected providers, newest first, to open a tab for the
   * worktree, and resolves once one serves it. A provider that refuses passes
   * the request on to the next. False when none is connected, all refused, or
   * nothing arrived within `timeoutMs`.
   */
  async openTab(worktreeId: string, timeoutMs: number): Promise<boolean> {
    if (this.tabs.has(worktreeId)) return true
    const deadline = Date.now() + timeoutMs
    const newestFirst = [...this.connections].reverse()
    for (const connection of newestFirst) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      if (await this.askToOpen(connection, worktreeId, remaining)) return true
    }
    return this.tabs.has(worktreeId)
  }

  /** Asks one provider to open a tab for the worktree; true once one serves it. */
  private async askToOpen(connection: ApiConnection, worktreeId: string, timeoutMs: number): Promise<boolean> {
    if (!this.connections.includes(connection)) return false
    const provided = this.waitForAttach(worktreeId, timeoutMs)
    const params: BrowserOpenParams = { worktreeId }
    try {
      await connection.endpoint.request('browser.open', params)
    } catch {
      return this.tabs.has(worktreeId)
    }
    return provided
  }

  /** Where the tab is: what the provider last said, moved along by navigation since. */
  location(worktreeId: string): { url: string; title: string } {
    const tab = this.require(worktreeId)
    return { url: tab.url, title: tab.title }
  }

  /** Sends one DevTools protocol command down the provider's connection; its error becomes ours. */
  async cdp(worktreeId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const tab = this.require(worktreeId)
    const request = tab.connection.endpoint.request('browser.cdp', { worktreeId, method, params })
    const result = await withTimeout(request, this.cdpTimeoutMs, `The browser did not answer ${method}`)
    if (method === 'Page.navigate' && typeof params.url === 'string') moveTo(tab, params.url)
    return result
  }

  /** What the tab logged since it was provided, oldest first. */
  consoleLog(worktreeId: string): BrowserConsoleEntry[] {
    return [...this.require(worktreeId).console]
  }

  /** What the tab requested since it was provided, oldest first. */
  networkLog(worktreeId: string): BrowserNetworkEntry[] {
    return [...this.require(worktreeId).network]
  }

  // ── Events ──────────────────────────────────────────────────────

  /** Records one `browser.cdpEvent`, when it is from the tab serving its worktree. */
  private receive(connection: ApiConnection, payload: unknown): void {
    const event = payload as BrowserCdpEvent | null
    if (!event || typeof event.worktreeId !== 'string' || typeof event.method !== 'string') return
    const tab = this.tabs.get(event.worktreeId)
    if (!tab) return
    if (tab.connection !== connection) return
    let params: Record<string, unknown> = {}
    if (event.params && typeof event.params === 'object') params = event.params
    recordEvent(tab, event.method, params)
  }

  // ── Plumbing ────────────────────────────────────────────────────

  /** A worktree's provided tab, or an error saying there is none. */
  private require(worktreeId: string): ProvidedTab {
    const tab = this.tabs.get(worktreeId)
    if (!tab) throw new Error('No browser tab serves this worktree.')
    return tab
  }

  /** Resolves whoever is waiting for a worktree's tab. */
  private wakeWaiters(worktreeId: string): void {
    const waiting = this.waiters.get(worktreeId)
    if (!waiting) return
    this.waiters.delete(worktreeId)
    for (const wake of waiting) wake()
  }

  /** Stops waking a waiter that gave up. */
  private dropWaiter(worktreeId: string, wake: () => void): void {
    const waiting = this.waiters.get(worktreeId)
    if (!waiting) return
    const remaining = waiting.filter((waiter) => waiter !== wake)
    if (remaining.length === 0) {
      this.waiters.delete(worktreeId)
      return
    }
    this.waiters.set(worktreeId, remaining)
  }
}

/** A freshly provided tab, with empty logs. */
function newTab(connection: ApiConnection, tab: BrowserTab): ProvidedTab {
  return {
    connection,
    url: tab.url,
    title: tab.title,
    console: [],
    network: [],
    requests: new Map()
  }
}

/** The tab is somewhere new, whose title is not known yet. */
function moveTo(tab: ProvidedTab, url: string): void {
  tab.url = url
  tab.title = ''
}

/** Folds one CDP event into the tab's logs and location; unknown events are ignored. */
function recordEvent(tab: ProvidedTab, method: string, params: Record<string, unknown>): void {
  if (method === 'Runtime.consoleAPICalled') {
    pushCapped(tab.console, consoleEntryOf(params))
    return
  }
  if (method === 'Runtime.exceptionThrown') {
    pushCapped(tab.console, exceptionEntryOf(params))
    return
  }
  if (method === 'Network.requestWillBeSent') {
    rememberRequest(tab, params)
    return
  }
  if (method === 'Network.responseReceived') {
    pushCapped(tab.network, responseEntryOf(tab, params))
    return
  }
  if (method === 'Network.loadingFailed') {
    pushCapped(tab.network, failureEntryOf(tab, params))
    return
  }
  if (method === 'Page.frameNavigated') {
    followFrame(tab, params)
    return
  }
  if (method === 'Page.navigatedWithinDocument' && typeof params.url === 'string') {
    tab.url = params.url
  }
}

/** A `Runtime.consoleAPICalled` as a console line: its arguments, space-separated. */
function consoleEntryOf(params: Record<string, unknown>): BrowserConsoleEntry {
  let level = 'log'
  if (typeof params.type === 'string') level = params.type
  let args: unknown[] = []
  if (Array.isArray(params.args)) args = params.args
  return {
    level,
    message: args.map(remoteObjectText).join(' '),
    source: sourceOfStack(params.stackTrace),
    at: Date.now()
  }
}

/** A `Runtime.exceptionThrown` as an error line. */
function exceptionEntryOf(params: Record<string, unknown>): BrowserConsoleEntry {
  const details = recordOf(params.exceptionDetails)
  const exception = recordOf(details.exception)
  let message = 'Uncaught exception'
  if (typeof details.text === 'string') message = details.text
  if (typeof exception.description === 'string') message = exception.description
  let source = ''
  if (typeof details.url === 'string' && details.url) source = `${details.url}:${Number(details.lineNumber)}`
  return { level: 'error', message, source, at: Date.now() }
}

/** A request the tab started, kept so a later response or failure can name it. */
function rememberRequest(tab: ProvidedTab, params: Record<string, unknown>): void {
  if (typeof params.requestId !== 'string') return
  const request = recordOf(params.request)
  tab.requests.set(params.requestId, { method: stringOr(request.method, 'GET'), url: stringOr(request.url, '') })
  // Requests that never finish would otherwise pile up for the tab's lifetime.
  if (tab.requests.size > LOG_LIMIT) {
    const oldest = tab.requests.keys().next().value
    if (oldest !== undefined) tab.requests.delete(oldest)
  }
}

/** A `Network.responseReceived` as a log entry. */
function responseEntryOf(tab: ProvidedTab, params: Record<string, unknown>): BrowserNetworkEntry {
  const response = recordOf(params.response)
  const started = startedRequest(tab, params)
  let url = started.url
  if (typeof response.url === 'string') url = response.url
  let status: number | null = null
  if (typeof response.status === 'number') status = response.status
  return { method: started.method, url, status, type: stringOr(params.type, ''), error: null, at: Date.now() }
}

/**
 * A `Network.loadingFailed` as a log entry. CDP leaves its URL out, so it
 * comes from the request's `Network.requestWillBeSent`, or a `url` the provider adds.
 */
function failureEntryOf(tab: ProvidedTab, params: Record<string, unknown>): BrowserNetworkEntry {
  const started = startedRequest(tab, params)
  let url = started.url
  if (typeof params.url === 'string') url = params.url
  if (!url) url = `request ${String(params.requestId)}`
  return {
    method: started.method,
    url,
    status: null,
    type: stringOr(params.type, ''),
    error: stringOr(params.errorText, 'failed'),
    at: Date.now()
  }
}

/** The start of the request an event is about, taken off the list; a bare GET when unknown. */
function startedRequest(tab: ProvidedTab, params: Record<string, unknown>): RequestStart {
  const requestId = String(params.requestId)
  const started = tab.requests.get(requestId)
  if (!started) return { method: 'GET', url: '' }
  tab.requests.delete(requestId)
  return started
}

/** Moves the tab along when its top frame navigated. */
function followFrame(tab: ProvidedTab, params: Record<string, unknown>): void {
  const frame = recordOf(params.frame)
  if (frame.parentId) return
  if (typeof frame.url !== 'string') return
  moveTo(tab, frame.url)
}

/** A CDP RemoteObject as the console would print it. */
function remoteObjectText(value: unknown): string {
  const object = recordOf(value)
  if ('value' in object) {
    if (typeof object.value === 'string') return object.value
    return JSON.stringify(object.value)
  }
  if (typeof object.description === 'string') return object.description
  if (typeof object.unserializableValue === 'string') return object.unserializableValue
  return stringOr(object.type, '')
}

/** `url:line` of a stack trace's top frame, or empty. */
function sourceOfStack(stackTrace: unknown): string {
  const frames = recordOf(stackTrace).callFrames
  if (!Array.isArray(frames) || frames.length === 0) return ''
  const top = recordOf(frames[0])
  if (typeof top.url !== 'string' || !top.url) return ''
  return `${top.url}:${Number(top.lineNumber) + 1}`
}

/** A value as an object to read fields from; empty when it is not one. */
function recordOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

/** A value when it is a string, else the fallback. */
function stringOr(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  return fallback
}

/** Appends to a log, dropping the oldest entry once it is full. */
function pushCapped<Entry>(log: Entry[], entry: Entry): void {
  log.push(entry)
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
}

/** A promise that fails with `message` once a timeout passes without it settling. */
function withTimeout<Value>(promise: Promise<Value>, milliseconds: number, message: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} within ${milliseconds / 1000}s.`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
