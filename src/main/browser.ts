// The browser preview, as agents drive it.
//
// The page lives in a <webview> in the renderer's Browser pane, one per
// worktree; the pane hands its webContents id over here once it is ready.
// From then on this side reads it — console, network, DOM, pictures — and acts
// on it the way a person would: input goes through the DevTools protocol, so a
// click lands as a real pointer press wherever the window's focus is, and the
// user watches it happen in the pane.
//
// Console and network are collected from the moment a preview page exists, so
// an agent asking what went wrong sees what happened before it asked —
// loading included.

import { app, nativeImage, webContents as allWebContents, type WebContents } from 'electron'
import type {
  BrowserActivity,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserPickedElement
} from '../shared/types'
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, scriptCall } from './browserScripts'

/** The partition every preview shares, so logins survive a reload of the pane. */
export const BROWSER_PARTITION = 'persist:grove-browser'

// How much of each log is kept; older entries fall off the front.
const LOG_LIMIT = 300

export interface BrowserEvents {
  /** What an agent is doing in a preview, for the pane to show while it does. */
  onActivity(activity: BrowserActivity): void
}

interface AttachedBrowser {
  contents: WebContents
  logs: PageLogs
}

/** What a preview's page has logged and requested since it was created. */
interface PageLogs {
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
}

export class BrowserService {
  private browsers = new Map<string, AttachedBrowser>()
  // Every preview page's logs from the moment it exists, by web contents id:
  // the pane can only hand a page over once it has loaded, and what it did
  // while loading is usually what an agent needs to see.
  private logs = new Map<number, PageLogs>()
  private waiters = new Map<string, Array<() => void>>()
  private watchedSessions = new WeakSet<object>()

  constructor(private events: BrowserEvents) {}

  // ── Following pages ─────────────────────────────────────────────

  /** Starts logging every preview page as it is created; returns the inverse. */
  watchNewPages(): () => void {
    const onCreated = (_event: unknown, contents: WebContents): void => {
      if (contents.getType() === 'webview') this.follow(contents)
    }
    app.on('web-contents-created', onCreated)
    return () => {
      app.off('web-contents-created', onCreated)
    }
  }

  /** Logs one page's console and requests until it is destroyed; returns its logs. */
  private follow(contents: WebContents): PageLogs {
    const logs: PageLogs = { console: [], network: [] }
    const id = contents.id
    this.logs.set(id, logs)
    this.watchNetwork(contents)
    contents.on('console-message', (details) => {
      pushCapped(logs.console, {
        level: details.level,
        message: details.message,
        source: sourceOf(details.sourceId, details.lineNumber),
        at: Date.now()
      })
    })
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (!mainFrame || code === -3) return
      pushCapped(logs.console, {
        level: 'error',
        message: `Failed to load ${url}: ${description} (${code})`,
        source: '',
        at: Date.now()
      })
    })
    // Popups open in the preview itself rather than in a window of their own.
    contents.setWindowOpenHandler((details) => {
      void contents.loadURL(details.url)
      return { action: 'deny' }
    })
    contents.once('destroyed', () => this.forget(id))
    return logs
  }

  /** Drops a destroyed page: its logs, and the worktree it was attached to. */
  private forget(contentsId: number): void {
    this.logs.delete(contentsId)
    for (const [worktreeId, browser] of this.browsers) {
      if (browser.contents.id === contentsId) this.browsers.delete(worktreeId)
    }
  }

  /** Records requests of every preview sharing this one's session. */
  private watchNetwork(contents: WebContents): void {
    const session = contents.session
    if (this.watchedSessions.has(session)) return
    this.watchedSessions.add(session)
    session.webRequest.onCompleted((details) => {
      this.recordRequest(details.webContentsId, {
        method: details.method,
        url: details.url,
        status: details.statusCode,
        type: details.resourceType,
        error: null,
        at: Date.now()
      })
    })
    session.webRequest.onErrorOccurred((details) => {
      this.recordRequest(details.webContentsId, {
        method: details.method,
        url: details.url,
        status: null,
        type: details.resourceType,
        error: details.error,
        at: Date.now()
      })
    })
  }

  /** Adds a request to the log of the page that made it. */
  private recordRequest(contentsId: number | undefined, entry: BrowserNetworkEntry): void {
    if (contentsId === undefined) return
    const logs = this.logs.get(contentsId)
    if (logs) pushCapped(logs.network, entry)
  }

  // ── Attaching ───────────────────────────────────────────────────

  /** Takes over the pane's page for a worktree, replacing whatever had it before. */
  attach(worktreeId: string, contentsId: number): void {
    const contents = allWebContents.fromId(contentsId)
    if (!contents) throw new Error('No such web contents.')
    // Only a preview is ever driven: never the workbench itself.
    if (contents.getType() !== 'webview') throw new Error('Only a browser preview can be attached.')
    this.detach(worktreeId)
    let logs = this.logs.get(contentsId)
    if (!logs) logs = this.follow(contents)
    this.browsers.set(worktreeId, { contents, logs })
    this.wakeWaiters(worktreeId)
  }

  /** Lets go of a worktree's preview, when it is still the one given. */
  detach(worktreeId: string, contentsId?: number): void {
    const browser = this.browsers.get(worktreeId)
    if (!browser) return
    if (contentsId !== undefined && browser.contents.id !== contentsId) return
    if (!browser.contents.isDestroyed() && browser.contents.debugger.isAttached()) {
      browser.contents.debugger.detach()
    }
    this.browsers.delete(worktreeId)
  }

  /** Whether a worktree has a preview open. */
  isAttached(worktreeId: string): boolean {
    return this.browsers.has(worktreeId)
  }

  /** Resolves once a worktree has a preview open, or false after `timeoutMs`. */
  waitForAttach(worktreeId: string, timeoutMs: number): Promise<boolean> {
    if (this.browsers.has(worktreeId)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.browsers.has(worktreeId)), timeoutMs)
      const waiting = this.waiters.get(worktreeId) ?? []
      waiting.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
      this.waiters.set(worktreeId, waiting)
    })
  }

  /** Releases everything, for the app quitting. */
  dispose(): void {
    for (const worktreeId of this.browsers.keys()) this.detach(worktreeId)
  }

  /** Resolves whoever is waiting for a worktree's preview to open. */
  private wakeWaiters(worktreeId: string): void {
    const waiting = this.waiters.get(worktreeId)
    if (!waiting) return
    this.waiters.delete(worktreeId)
    for (const wake of waiting) wake()
  }

  // ── Reading ─────────────────────────────────────────────────────

  /** The page's address and title. */
  location(worktreeId: string): { url: string; title: string } {
    const contents = this.require(worktreeId).contents
    return { url: contents.getURL(), title: contents.getTitle() }
  }

  /** What the page has logged since the pane attached, oldest first. */
  consoleLog(worktreeId: string): BrowserConsoleEntry[] {
    return [...this.require(worktreeId).logs.console]
  }

  /** What the page has requested since the pane attached, oldest first. */
  networkLog(worktreeId: string): BrowserNetworkEntry[] {
    return [...this.require(worktreeId).logs.network]
  }

  /**
   * Lets the user point at an element in the page; resolves with it, or null
   * when they pressed Escape or the pick was cancelled.
   */
  async pick(worktreeId: string): Promise<BrowserPickedElement | null> {
    return (await this.run(worktreeId, scriptCall(PICK_SCRIPT, {}))) as BrowserPickedElement | null
  }

  /** Ends a pick in progress. */
  async cancelPick(worktreeId: string): Promise<void> {
    await this.run(worktreeId, `${CANCEL_PICK_SCRIPT}()`).catch(() => {})
  }

  // ── Acting ──────────────────────────────────────────────────────

  /**
   * Sends one DevTools protocol command to the page, telling the pane what it
   * does when it acts on the page. A screenshot comes back at one pixel per
   * CSS pixel, so a point in it is the point Input.* takes.
   */
  async cdp(worktreeId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const activity = activityOf(method, params)
    if (activity) this.announce(worktreeId, activity)
    const result = await this.command(worktreeId, method, params)
    if (method !== 'Page.captureScreenshot') return result
    return scaledScreenshot(result, params, await this.cssWidthOf(worktreeId, params))
  }

  /** How many CSS pixels wide a screenshot with these parameters covers. */
  private async cssWidthOf(worktreeId: string, params: Record<string, unknown>): Promise<number> {
    const clip = params.clip as { width?: unknown; scale?: unknown } | undefined
    if (clip && typeof clip.width === 'number') {
      let scale = 1
      if (typeof clip.scale === 'number') scale = clip.scale
      return clip.width * scale
    }
    return Number(await this.run(worktreeId, 'innerWidth'))
  }

  // ── Plumbing ────────────────────────────────────────────────────

  /** Says what an agent is doing in the preview, for the pane to show. */
  private announce(worktreeId: string, text: string): void {
    this.events.onActivity({ worktreeId, text, at: Date.now() })
  }

  /** Sends a DevTools protocol command, attaching the debugger on first use. */
  private async command(worktreeId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const contents = this.require(worktreeId).contents
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    return contents.debugger.sendCommand(method, params)
  }

  /** Evaluates script in the page, with its exceptions as errors. */
  private async run(worktreeId: string, script: string): Promise<unknown> {
    const contents = this.require(worktreeId).contents
    return contents.executeJavaScript(script, true)
  }

  /** A worktree's preview, or an error saying there is none. */
  private require(worktreeId: string): AttachedBrowser {
    const browser = this.browsers.get(worktreeId)
    if (!browser || browser.contents.isDestroyed()) {
      throw new Error('No browser preview is open for this worktree.')
    }
    return browser
  }
}

/** Appends to a log, dropping the oldest entry once it is full. */
function pushCapped<Entry>(log: Entry[], entry: Entry): void {
  log.push(entry)
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
}

/** Where a console message came from, as `url:line`. */
function sourceOf(sourceId: string, lineNumber: number): string {
  if (!sourceId) return ''
  return `${sourceId}:${lineNumber}`
}

/** Text cut to a length, with an ellipsis when it was cut. */
function shorten(text: string, length: number): string {
  if (text.length <= length) return text
  return `${text.slice(0, length - 1)}…`
}

/** What a command does to the page, in words for the pane; null for one that only reads. */
function activityOf(method: string, params: Record<string, unknown>): string | null {
  if (method === 'Page.navigate') return `Opening ${String(params.url)}`
  if (method === 'Input.insertText') return `Typing “${shorten(String(params.text), 40)}”`
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
    return `Clicking at ${Math.round(Number(params.x))},${Math.round(Number(params.y))}`
  }
  if (method === 'Input.dispatchKeyEvent' && (params.type === 'keyDown' || params.type === 'rawKeyDown')) {
    if (typeof params.key === 'string') return `Pressing ${params.key}`
    return `Pressing ${String(params.code)}`
  }
  return null
}

/**
 * A screenshot's result scaled down to `cssWidth`: Chromium takes it in device
 * pixels, twice as wide as the page on a HiDPI screen.
 */
function scaledScreenshot(result: unknown, params: Record<string, unknown>, cssWidth: number): unknown {
  const data = (result as { data?: unknown } | null)?.data
  if (typeof data !== 'string' || params.format === 'webp') return result
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) return result
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  if (image.getSize().width <= cssWidth) return result
  const scaled = image.resize({ width: Math.round(cssWidth) })
  if (params.format === 'jpeg') {
    let quality = 80
    if (typeof params.quality === 'number') quality = params.quality
    return { ...(result as object), data: scaled.toJPEG(quality).toString('base64') }
  }
  return { ...(result as object), data: scaled.toPNG().toString('base64') }
}
