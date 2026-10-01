// Driving the worktree's browser.
//
// Every session gets this: the browser belongs to the worktree, not to one
// agent, so whichever agent is working on the frontend can look at what it
// built and use it. The calls land in a page the user is looking at — a tab
// handed to the worktree from Kit or Chrome, or else the Browser pane — and they watch the
// clicks and the typing happen.
//
// The tool is the DevTools protocol, unwrapped. Models know CDP far better
// than any set of wrappers grove could write, and a wrapper only gets in the
// way where it did not anticipate something: iframes, shadow DOM, scrolling,
// uploads. What CDP cannot give a request/response tool — what the page logged
// in between — rides along on each reply. And like any codebase, what the model
// finds itself repeating it keeps: a script runs with the helpers file in
// scope, and the model adds to that file with its own edit tool.

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { createContext, runInContext } from 'vm'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from '../../../shared/types'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'
import { stringOrNothing } from './toolInput'

/** What the tool needs of the browser service, keyed by worktree. */
export interface AgentBrowser {
  isAttached(worktreeId: string): boolean
  waitForAttach(worktreeId: string, timeoutMs: number): Promise<boolean>
  /**
   * Asks a connected browser provider to open a tab for the worktree; true
   * once one serves it, false when there is none or none did.
   */
  openTab(worktreeId: string, timeoutMs: number): Promise<boolean>
  location(worktreeId: string): { url: string; title: string }
  /** Sends one DevTools protocol command to the page and returns its result. */
  cdp(worktreeId: string, method: string, params: Record<string, unknown>): Promise<unknown>
  consoleLog(worktreeId: string): BrowserConsoleEntry[]
  networkLog(worktreeId: string): BrowserNetworkEntry[]
}

// How long to wait for the pane to open and hand its page over.
const ATTACH_TIMEOUT_MS = 8000
// How long to wait for a connected provider to open a tab and provide it.
const PROVIDER_OPEN_TIMEOUT_MS = 5000
// Characters of a command's result returned before it is cut.
const MAX_RESULT_LENGTH = 20000
// The most entries of each log one reply carries; the newest are kept.
const EVENT_ENTRIES = 10
// Characters of one log line before it is cut.
const EVENT_LINE_LENGTH = 200
// How long a script may run before it is given up on.
const SCRIPT_TIMEOUT_MS = 30000

// What the helpers file holds before the model has added anything.
const STARTER_HELPERS = `// Helpers for the browser tool's scripts. Every function declared here is in
// scope in a script, beside cdp(method, params) and sleep(ms). Add what you
// find yourself repeating; keep each one small and say what it does.

/** Evaluates an expression in the page and returns its value. */
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
  return result.value
}

/** Waits until the page has finished loading, or the timeout passes. */
async function waitForLoad(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if ((await evaluate('document.readyState')) === 'complete') return true
    await sleep(100)
  }
  return false
}

/** Clicks a point in the viewport the way a pointer would. */
async function clickAt(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

/** Clicks the centre of the first element a selector matches, scrolled into view. */
async function click(selector) {
  const point = await evaluate(\`(() => {
    const element = document.querySelector(\${JSON.stringify(selector)})
    if (!element) return null
    element.scrollIntoView({ block: 'center' })
    const box = element.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()\`)
  if (!point) throw new Error(\`Nothing matches \${selector}\`)
  await clickAt(point.x, point.y)
}
`

export interface BrowserToolOptions {
  /** The file of helpers a script runs with, which the model edits itself. */
  helpersPath: string
}

const NOT_OPEN =
  'No browser serves this worktree: no browser tab is handed to it, and the Browser pane is not ' +
  'open and could not be opened (the user is not looking at this conversation, or has another ' +
  'worktree selected). Ask the user to hand a tab to this worktree from Kit or from Grove’s ' +
  'Chrome extension, or to open the Browser pane, then try again.'

/** The last log entries a session has been told about, so each reply carries only what is new. */
interface SeenEvents {
  console: BrowserConsoleEntry | null
  network: BrowserNetworkEntry | null
}

/** The DevTools protocol tool over the worktree's browser. */
export function browserTools(browser: AgentBrowser, options: BrowserToolOptions): GroveTool[] {
  return [browserTool(browser, options)]
}

function browserTool(browser: AgentBrowser, options: BrowserToolOptions): GroveTool {
  const seen = new Map<string, SeenEvents>()
  return {
    name: 'browser',
    summary: 'Drive the worktree’s browser with DevTools protocol commands',
    promptGuidelines: [
      'For frontend work, check what you built in the Browser preview rather than assuming it renders'
    ],
    description:
      'Send one Chrome DevTools Protocol command to the worktree’s browser: a tab the user handed ' +
      'to the worktree from Kit or Chrome when there is one, else the Browser pane, the worktree’s ' +
      'preview of its dev server. When neither is open, a connected browser is asked for a tab, ' +
      'else the pane is opened. ' +
      'The user watches it happen. ' +
      'Any domain works: Page.navigate, Runtime.evaluate (returnByValue: true for a plain value), ' +
      'Input.dispatchMouseEvent, Input.insertText, Input.dispatchKeyEvent, DOM.*, ' +
      'Accessibility.getFullAXTree, Page.captureScreenshot (returned as an image, one pixel per CSS ' +
      'pixel, so a point in it is the point Input.* takes). Navigation does ' +
      'not wait for the load. For several steps in one call, pass a script instead: the body of an ' +
      'async JavaScript function with cdp(method, params), sleep(ms) and your helpers in scope, ' +
      `whose return value is the reply. Your helpers are the functions in ${options.helpersPath}; ` +
      'read it to see them, and add to it with your file tools whatever you find yourself repeating. ' +
      'Each reply ends with the console messages and failed requests the page logged since your last call.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'The protocol method, e.g. "Runtime.evaluate".' },
        params: { type: 'object', description: 'The method’s parameters, as the protocol defines them.' },
        script: {
          type: 'string',
          description: 'Instead of a method: an async function body run with cdp, sleep and your helpers.'
        }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{method}', input: 'hidden', result: 'text' },

    async execute(input, context) {
      const method = stringOrNothing(input.method)
      const script = stringOrNothing(input.script)
      if (!method && !script) {
        return { content: 'Give a protocol method, e.g. "Page.navigate", or a script.', isError: true }
      }
      let params: Record<string, unknown> = {}
      if (input.params && typeof input.params === 'object') params = input.params as Record<string, unknown>

      const worktreeId = await ensureBrowser(browser, context)
      if (worktreeId === null) return { content: NOT_OPEN, isError: true }
      let result: GroveToolResult
      try {
        if (method) {
          result = replyFor(method, params, await browser.cdp(worktreeId, method, params))
        } else {
          result = replyFor('', {}, await runScript(browser, worktreeId, String(script), options.helpersPath))
        }
      } catch (error) {
        result = { content: (error as Error).message, isError: true }
      }
      const events = newEvents(browser, worktreeId, seenBy(seen, context.sessionId))
      const parts = [result.content, events, whereNow(browser, worktreeId)].filter((part) => part.length > 0)
      return { ...result, content: parts.join('\n\n') }
    }
  }
}

/**
 * The worktree's browser: the page already serving it, else a tab a connected
 * browser opens, else the Browser pane opened for it. Null when none arrived in time.
 */
async function ensureBrowser(browser: AgentBrowser, context: GroveToolContext): Promise<string | null> {
  const worktreeId = context.workspaceRoot
  if (browser.isAttached(worktreeId)) return worktreeId
  if (await browser.openTab(worktreeId, PROVIDER_OPEN_TIMEOUT_MS)) return worktreeId
  context.show({ kind: 'pane', pane: 'browser' })
  const attached = await browser.waitForAttach(worktreeId, ATTACH_TIMEOUT_MS)
  if (!attached) return null
  return worktreeId
}

/**
 * Runs a script against the page with the helpers file in scope, and returns
 * what it returns. The helpers file is written with the starter helpers the
 * first time it is needed. The script runs in a context of its own with only
 * cdp and sleep, so a slip cannot reach the rest of grove by accident.
 */
export async function runScript(
  browser: AgentBrowser,
  worktreeId: string,
  script: string,
  helpersPath: string
): Promise<unknown> {
  const helpers = await helpersSource(helpersPath)
  const context = createContext({
    cdp: (method: string, params: Record<string, unknown> = {}) => browser.cdp(worktreeId, method, params),
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
  try {
    runInContext(helpers, context, { filename: helpersPath })
  } catch (error) {
    throw new Error(`The helpers file does not run: ${(error as Error).message}. Fix ${helpersPath}.`)
  }
  const running = runInContext(`(async () => {\n${script}\n})()`, context, { filename: 'script' }) as Promise<unknown>
  return withTimeout(running, SCRIPT_TIMEOUT_MS)
}

/** The helpers file's text, written with the starter helpers when it does not exist yet. */
async function helpersSource(helpersPath: string): Promise<string> {
  try {
    return await readFile(helpersPath, 'utf8')
  } catch {
    await mkdir(dirname(helpersPath), { recursive: true })
    await writeFile(helpersPath, STARTER_HELPERS)
    return STARTER_HELPERS
  }
}

/** A promise that fails once a timeout passes without it settling. */
function withTimeout<Value>(promise: Promise<Value>, milliseconds: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The script did not finish within ${milliseconds / 1000}s.`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** A command's result as the model reads it: a screenshot as a picture, anything else as JSON. */
export function replyFor(method: string, params: Record<string, unknown>, result: unknown): GroveToolResult {
  const data = (result as { data?: unknown } | null)?.data
  if (method === 'Page.captureScreenshot' && typeof data === 'string') {
    let mimeType = 'image/png'
    if (params.format === 'jpeg') mimeType = 'image/jpeg'
    if (params.format === 'webp') mimeType = 'image/webp'
    return { content: 'Screenshot of the preview.', images: [{ data, mimeType }] }
  }
  if (result === undefined || (typeof result === 'object' && result !== null && Object.keys(result).length === 0)) {
    return { content: 'Done.' }
  }
  const text = JSON.stringify(result)
  if (text.length <= MAX_RESULT_LENGTH) return { content: text }
  return {
    content: `${text.slice(0, MAX_RESULT_LENGTH)}\n[Cut at ${MAX_RESULT_LENGTH} of ${text.length} characters; ask for less.]`
  }
}

/** What a session has been told about so far, starting from nothing. */
function seenBy(seen: Map<string, SeenEvents>, sessionId: string): SeenEvents {
  let entry = seen.get(sessionId)
  if (!entry) {
    entry = { console: null, network: null }
    seen.set(sessionId, entry)
  }
  return entry
}

/**
 * The console messages and failed requests logged since the session last
 * heard, capped so a chatty page cannot flood the conversation. Empty when
 * nothing new happened.
 */
export function newEvents(browser: AgentBrowser, worktreeId: string, seen: SeenEvents): string {
  const consoleLog = browser.consoleLog(worktreeId)
  const networkLog = browser.networkLog(worktreeId)
  const consoleEntries = after(consoleLog, seen.console)
  const networkEntries = after(networkLog, seen.network).filter(failed)
  seen.console = lastOf(consoleLog)
  seen.network = lastOf(networkLog)

  const sections: string[] = []
  if (consoleEntries.length > 0) {
    sections.push(capped('Console since your last call:', consoleEntries.map(consoleLine)))
  }
  if (networkEntries.length > 0) {
    sections.push(capped('Failed requests since your last call:', networkEntries.map(networkLine)))
  }
  return sections.join('\n')
}

/** The entries after the last one already seen; all of them when it is gone or there was none. */
function after<Entry>(entries: Entry[], last: Entry | null): Entry[] {
  if (last === null) return entries
  const index = entries.lastIndexOf(last)
  if (index < 0) return entries
  return entries.slice(index + 1)
}

function lastOf<Entry>(entries: Entry[]): Entry | null {
  if (entries.length === 0) return null
  return entries[entries.length - 1]
}

/** A request that failed: no response, or an error status. */
function failed(entry: BrowserNetworkEntry): boolean {
  if (entry.error) return true
  return entry.status !== null && entry.status >= 400
}

/** The newest lines under a heading, saying how many older ones were left out. */
function capped(heading: string, lines: string[]): string {
  const shown = lines.slice(-EVENT_ENTRIES)
  const output = [heading]
  if (lines.length > shown.length) output.push(`[${lines.length - shown.length} earlier left out]`)
  output.push(...shown)
  return output.join('\n')
}

function consoleLine(entry: BrowserConsoleEntry): string {
  let line = `- ${entry.level}: ${entry.message}`
  if (entry.source) line += ` (${entry.source})`
  return shorten(line)
}

function networkLine(entry: BrowserNetworkEntry): string {
  let outcome = String(entry.status)
  if (entry.error) outcome = entry.error
  return shorten(`- ${entry.method} ${entry.url} → ${outcome}`)
}

/** A log line cut to length, on one line. */
function shorten(line: string): string {
  const single = line.replace(/\s*\n\s*/g, ' ')
  if (single.length <= EVENT_LINE_LENGTH) return single
  return `${single.slice(0, EVENT_LINE_LENGTH - 1)}…`
}

/** Where the page is now, as a line a reply ends with. */
function whereNow(browser: AgentBrowser, worktreeId: string): string {
  const { url, title } = browser.location(worktreeId)
  if (!title) return `Now at ${url}.`
  return `Now at ${url} (“${title}”).`
}
