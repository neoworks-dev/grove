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

import { app, webContents as allWebContents, type WebContents } from 'electron'
import type {
  BrowserActivity,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserPickedElement
} from '../shared/types'
import {
  CANCEL_PICK_SCRIPT,
  CLICK_POINT_SCRIPT,
  HIGHLIGHT_SCRIPT,
  HTML_SCRIPT,
  PICK_SCRIPT,
  SNAPSHOT_SCRIPT,
  scriptCall
} from './browserScripts'

/** The partition every preview shares, so logins survive a reload of the pane. */
export const BROWSER_PARTITION = 'persist:grove-browser'

// How much of each log is kept; older entries fall off the front.
const LOG_LIMIT = 300
// How long a navigation may take before the agent is told it is still loading.
const LOAD_TIMEOUT_MS = 15000
// Screenshots wider than this are scaled down: plenty to read, far fewer tokens.
const SCREENSHOT_MAX_WIDTH = 1280

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

/** A point in the page's viewport, in CSS pixels. */
export interface PagePoint {
  x: number
  y: number
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

  /** A PNG of what the preview shows, scaled down when it is wide. */
  async screenshot(worktreeId: string): Promise<string> {
    const contents = this.require(worktreeId).contents
    let image = await contents.capturePage()
    const size = image.getSize()
    if (size.width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH })
    return image.toPNG().toString('base64')
  }

  /** An outline of the page: its text and the elements that can be acted on. */
  snapshot(worktreeId: string): Promise<unknown> {
    return this.run(worktreeId, scriptCall(SNAPSHOT_SCRIPT, {}))
  }

  /** The HTML of the elements a selector matches, or of the whole page. */
  html(worktreeId: string, selector: string | null): Promise<unknown> {
    return this.run(worktreeId, scriptCall(HTML_SCRIPT, { selector }))
  }

  /** The value of an expression evaluated in the page. */
  evaluate(worktreeId: string, expression: string): Promise<unknown> {
    return this.run(worktreeId, expression)
  }

  /** What the page has logged since the pane attached, oldest first. */
  consoleLog(worktreeId: string): BrowserConsoleEntry[] {
    return [...this.require(worktreeId).logs.console]
  }

  /** What the page has requested since the pane attached, oldest first. */
  networkLog(worktreeId: string): BrowserNetworkEntry[] {
    return [...this.require(worktreeId).logs.network]
  }

  /** Forgets the console and network logs, so the next read shows only what follows. */
  clearLogs(worktreeId: string): void {
    const logs = this.require(worktreeId).logs
    logs.console.length = 0
    logs.network.length = 0
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

  /** Loads an address and waits for it to finish, or for the timeout. */
  async navigate(worktreeId: string, url: string): Promise<void> {
    const contents = this.require(worktreeId).contents
    this.announce(worktreeId, `Opening ${url}`)
    await Promise.race([
      contents.loadURL(url).catch((error: Error) => {
        // An aborted load (ERR_ABORTED) is a redirect or a second navigation, not a failure.
        if (!error.message.includes('ERR_ABORTED')) throw error
      }),
      delay(LOAD_TIMEOUT_MS)
    ])
  }

  /**
   * Clicks an element, or a point in the viewport: scrolled into view, marked
   * for the user to see, then pressed as a real pointer would.
   */
  async click(worktreeId: string, target: { selector: string } | PagePoint): Promise<string> {
    const point = await this.pointOf(worktreeId, target)
    this.announce(worktreeId, `Clicking ${describeTarget(target)}`)
    await this.highlight(worktreeId, target)
    await this.mouse(worktreeId, 'mouseMoved', point)
    await this.mouse(worktreeId, 'mousePressed', point)
    await this.mouse(worktreeId, 'mouseReleased', point)
    return `${Math.round(point.x)},${Math.round(point.y)}`
  }

  /** Types text into an element (clicked first) or into whatever has focus. */
  async type(worktreeId: string, text: string, selector: string | null): Promise<void> {
    if (selector) await this.click(worktreeId, { selector })
    this.announce(worktreeId, `Typing “${shorten(text, 40)}”`)
    await this.command(worktreeId, 'Input.insertText', { text })
  }

  /** Presses one key, such as Enter, Tab, Escape or ArrowDown. */
  async press(worktreeId: string, key: string): Promise<void> {
    this.announce(worktreeId, `Pressing ${key}`)
    const definition = keyDefinition(key)
    await this.command(worktreeId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...definition })
    await this.command(worktreeId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...definition })
  }

  /** Scrolls the page, or an element into view. */
  async scroll(worktreeId: string, deltaY: number): Promise<void> {
    const viewport = (await this.run(worktreeId, '({ x: innerWidth / 2, y: innerHeight / 2 })')) as PagePoint
    await this.command(worktreeId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: viewport.x,
      y: viewport.y,
      deltaX: 0,
      deltaY
    })
  }

  // ── Plumbing ────────────────────────────────────────────────────

  /** Says what an agent is doing in the preview, for the pane to show. */
  private announce(worktreeId: string, text: string): void {
    this.events.onActivity({ worktreeId, text, at: Date.now() })
  }

  /** Where in the viewport a target is, scrolling an element into view first. */
  private async pointOf(worktreeId: string, target: { selector: string } | PagePoint): Promise<PagePoint> {
    if (!('selector' in target)) return target
    const found = (await this.run(worktreeId, scriptCall(CLICK_POINT_SCRIPT, { selector: target.selector }))) as
      | PagePoint
      | { error: string }
    if ('error' in found) throw new Error(found.error)
    return found
  }

  /** Outlines what is about to be acted on, briefly, in the page itself. */
  private async highlight(worktreeId: string, target: { selector: string } | PagePoint): Promise<void> {
    await this.run(worktreeId, scriptCall(HIGHLIGHT_SCRIPT, target)).catch(() => {})
  }

  /** One pointer event at a point. */
  private mouse(worktreeId: string, type: string, point: PagePoint): Promise<unknown> {
    return this.command(worktreeId, 'Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1
    })
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

/** A target as the pane's activity line names it. */
function describeTarget(target: { selector: string } | PagePoint): string {
  if ('selector' in target) return target.selector
  return `${Math.round(target.x)},${Math.round(target.y)}`
}

/** Text cut to a length, with an ellipsis when it was cut. */
function shorten(text: string, length: number): string {
  if (text.length <= length) return text
  return `${text.slice(0, length - 1)}…`
}

/** Resolves after a while. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// The keys an agent presses by name, as the protocol wants them described.
const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' }
}

/** The protocol's description of a key pressed by name, or of a single character. */
export function keyDefinition(key: string): Record<string, unknown> {
  const named = NAMED_KEYS[key]
  if (named) {
    let keyName = key
    if (key === 'Space') keyName = ' '
    const definition: Record<string, unknown> = {
      key: keyName,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode
    }
    if (named.text) definition.text = named.text
    return definition
  }
  if (key.length !== 1) throw new Error(`Unknown key: ${key}. Use a single character or one of ${Object.keys(NAMED_KEYS).join(', ')}.`)
  return { key, text: key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }
}
