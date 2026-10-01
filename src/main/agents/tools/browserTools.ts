// Driving the worktree's browser preview.
//
// Every session gets these: the preview belongs to the worktree, not to one
// agent, so whichever agent is working on the frontend can look at what it
// built and use it. The calls land in the Browser pane the user is looking at
// — they watch the clicks and the typing happen.

import type { BrowserConsoleEntry, BrowserNetworkEntry } from '../../../shared/types'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'
import { numberOf, textOf } from './toolInput'

/** What the tools need of the browser service, keyed by worktree. */
export interface AgentBrowser {
  isAttached(worktreeId: string): boolean
  waitForAttach(worktreeId: string, timeoutMs: number): Promise<boolean>
  location(worktreeId: string): { url: string; title: string }
  navigate(worktreeId: string, url: string): Promise<void>
  snapshot(worktreeId: string): Promise<unknown>
  screenshot(worktreeId: string): Promise<string>
  html(worktreeId: string, selector: string | null): Promise<unknown>
  evaluate(worktreeId: string, expression: string): Promise<unknown>
  click(worktreeId: string, target: { selector: string } | { x: number; y: number }): Promise<string>
  type(worktreeId: string, text: string, selector: string | null): Promise<void>
  press(worktreeId: string, key: string): Promise<void>
  consoleLog(worktreeId: string): BrowserConsoleEntry[]
  networkLog(worktreeId: string): BrowserNetworkEntry[]
  clearConsole(worktreeId: string): void
  clearNetwork(worktreeId: string): void
}

// How long to wait for the pane to open and hand its page over.
const ATTACH_TIMEOUT_MS = 8000
// The most log entries one call returns; the newest are kept.
const LOG_ENTRIES = 80

const NOT_OPEN =
  'The Browser pane is not open for this worktree, and could not be opened: the user is not ' +
  'looking at this conversation, or has another worktree selected. Ask them to open the ' +
  'Browser pane (it loads the worktree’s dev server), then try again.'

/** Every tool that drives the browser preview. */
export function browserTools(browser: AgentBrowser): GroveTool[] {
  return [
    navigateTool(browser),
    snapshotTool(browser),
    screenshotTool(browser),
    clickTool(browser),
    typeTool(browser),
    pressTool(browser),
    htmlTool(browser),
    consoleTool(browser),
    networkTool(browser),
    evaluateTool(browser)
  ]
}

/**
 * The worktree's preview, opening the Browser pane first when it is not open.
 * Null when it did not open in time.
 */
async function ensureBrowser(browser: AgentBrowser, context: GroveToolContext): Promise<string | null> {
  const worktreeId = context.workspaceRoot
  if (browser.isAttached(worktreeId)) return worktreeId
  context.show({ kind: 'pane', pane: 'browser' })
  const attached = await browser.waitForAttach(worktreeId, ATTACH_TIMEOUT_MS)
  if (!attached) return null
  return worktreeId
}

/** Runs a call against the worktree's preview, or says why it can't. */
async function withBrowser(
  browser: AgentBrowser,
  context: GroveToolContext,
  run: (worktreeId: string) => Promise<GroveToolResult> | GroveToolResult
): Promise<GroveToolResult> {
  const worktreeId = await ensureBrowser(browser, context)
  if (worktreeId === null) return { content: NOT_OPEN, isError: true }
  try {
    return await run(worktreeId)
  } catch (error) {
    return { content: (error as Error).message, isError: true }
  }
}

/** Where the page is now, as a line a result ends with. */
function whereNow(browser: AgentBrowser, worktreeId: string): string {
  const { url, title } = browser.location(worktreeId)
  if (!title) return `Now at ${url}.`
  return `Now at ${url} (“${title}”).`
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false }

/** Opens an address in the preview. */
function navigateTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_navigate',
    summary: 'Open an address in the worktree’s browser preview.',
    promptGuidelines: [
      'For frontend work, check what you built in the Browser preview (browser_* tools) rather than assuming it renders: navigate, browser_snapshot to see the page, browser_screenshot to look at it, and browser_console for errors'
    ],
    description:
      'Open a URL in the Browser pane, the worktree’s preview of its dev server, opening the pane ' +
      'when it is not open. The user sees the page change. Waits for the page to load.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The address, e.g. http://localhost:3100/settings.' } },
      required: ['url'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{url}', input: 'hidden', result: 'text' },
    async execute(input, context) {
      const url = textOf(input.url)
      if (!url) return { content: 'Give a url to open.', isError: true }
      return withBrowser(browser, context, async (worktreeId) => {
        await browser.navigate(worktreeId, url)
        return { content: whereNow(browser, worktreeId) }
      })
    }
  }
}

/** The page in outline. */
function snapshotTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_snapshot',
    summary: 'Read the preview’s page: its text and what can be clicked or typed into.',
    description:
      'The page in the Browser pane in outline: address, title, visible text, and the elements ' +
      'that can be acted on, each with a CSS selector to pass to browser_click or browser_type.',
    inputSchema: NO_INPUT,
    policy: 'allow',
    display: { label: 'page outline', input: 'hidden', result: 'hidden' },
    async execute(_input, context) {
      return withBrowser(browser, context, async (worktreeId) => {
        const snapshot = await browser.snapshot(worktreeId)
        return { content: JSON.stringify(snapshot, null, 1) }
      })
    }
  }
}

/** A picture of the page. */
function screenshotTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_screenshot',
    summary: 'Look at the preview: a screenshot of what the Browser pane shows.',
    description: 'A screenshot of the page in the Browser pane, as the user sees it.',
    inputSchema: NO_INPUT,
    policy: 'allow',
    display: { label: 'screenshot', input: 'hidden', result: 'hidden' },
    async execute(_input, context) {
      return withBrowser(browser, context, async (worktreeId) => {
        const data = await browser.screenshot(worktreeId)
        return {
          content: `Screenshot of the preview. ${whereNow(browser, worktreeId)}`,
          images: [{ data, mimeType: 'image/png' }]
        }
      })
    }
  }
}

/** A click on an element or a point. */
function clickTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_click',
    summary: 'Click an element in the preview.',
    description:
      'Click an element in the Browser pane by CSS selector (from browser_snapshot), or a point ' +
      'in the viewport by x and y. The element is scrolled into view and marked for the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{selector}', input: 'hidden', result: 'text' },
    async execute(input, context) {
      const target = clickTarget(input)
      if (!target) return { content: 'Give a selector, or both x and y.', isError: true }
      return withBrowser(browser, context, async (worktreeId) => {
        const point = await browser.click(worktreeId, target)
        return { content: `Clicked at ${point}. ${whereNow(browser, worktreeId)}` }
      })
    }
  }
}

/** What a click call aims at, or null when it names nothing. */
export function clickTarget(input: Record<string, unknown>): { selector: string } | { x: number; y: number } | null {
  const selector = textOf(input.selector)
  if (selector) return { selector }
  const x = numberOf(input.x)
  const y = numberOf(input.y)
  if (x === null || y === null) return null
  return { x, y }
}

/** Typing into the page. */
function typeTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_type',
    summary: 'Type into the preview.',
    description:
      'Type text into the Browser pane: into the element a selector names (clicked first to focus ' +
      'it), or into whatever has focus. Set submit to press Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        selector: { type: 'string' },
        submit: { type: 'boolean' }
      },
      required: ['text'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{text}', input: 'hidden', result: 'text' },
    async execute(input, context) {
      let text = ''
      if (typeof input.text === 'string') text = input.text
      return withBrowser(browser, context, async (worktreeId) => {
        await browser.type(worktreeId, text, textOf(input.selector))
        if (input.submit === true) await browser.press(worktreeId, 'Enter')
        return { content: `Typed. ${whereNow(browser, worktreeId)}` }
      })
    }
  }
}

/** One key. */
function pressTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_press',
    summary: 'Press a key in the preview.',
    description:
      'Press one key in the Browser pane: a single character, or Enter, Tab, Escape, Backspace, ' +
      'Delete, Space, Home, End, PageUp, PageDown or an arrow key (ArrowDown, …).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{key}', input: 'hidden', result: 'text' },
    async execute(input, context) {
      const key = textOf(input.key)
      if (!key) return { content: 'Give a key to press.', isError: true }
      return withBrowser(browser, context, async (worktreeId) => {
        await browser.press(worktreeId, key)
        return { content: `Pressed ${key}. ${whereNow(browser, worktreeId)}` }
      })
    }
  }
}

/** Markup. */
function htmlTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_html',
    summary: 'Read the HTML of the preview’s page, or of elements in it.',
    description:
      'The HTML of the elements a CSS selector matches in the Browser pane (the first five), or ' +
      'of the whole page without one. Long markup is cut.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{selector}', input: 'hidden', result: 'hidden' },
    async execute(input, context) {
      return withBrowser(browser, context, async (worktreeId) => {
        const html = await browser.html(worktreeId, textOf(input.selector))
        return { content: String(html) }
      })
    }
  }
}

/** The console log. */
function consoleTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_console',
    summary: 'Read what the preview’s page logged to its console.',
    description:
      'Console messages from the page in the Browser pane since it opened, newest last; failed ' +
      'page loads are included as errors. Set errorsOnly for warnings and errors only, and clear ' +
      'to start the log afresh after reading it.',
    inputSchema: {
      type: 'object',
      properties: { errorsOnly: { type: 'boolean' }, clear: { type: 'boolean' } },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: 'console', input: 'hidden', result: 'text' },
    async execute(input, context) {
      return withBrowser(browser, context, (worktreeId) => {
        let entries = browser.consoleLog(worktreeId)
        if (input.errorsOnly === true) entries = entries.filter(isProblem)
        if (input.clear === true) browser.clearConsole(worktreeId)
        return { content: describeConsole(entries) }
      })
    }
  }
}

/** The network log. */
function networkTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_network',
    summary: 'Read the requests the preview’s page made.',
    description:
      'Requests from the page in the Browser pane since it opened, newest last, with method, ' +
      'status and type. Set failedOnly for failed requests and error statuses only, and clear to ' +
      'start the log afresh after reading it.',
    inputSchema: {
      type: 'object',
      properties: { failedOnly: { type: 'boolean' }, clear: { type: 'boolean' } },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: 'network', input: 'hidden', result: 'text' },
    async execute(input, context) {
      return withBrowser(browser, context, (worktreeId) => {
        let entries = browser.networkLog(worktreeId)
        if (input.failedOnly === true) entries = entries.filter(isFailedRequest)
        if (input.clear === true) browser.clearNetwork(worktreeId)
        return { content: describeNetwork(entries) }
      })
    }
  }
}

/** A script in the page. */
function evaluateTool(browser: AgentBrowser): GroveTool {
  return {
    name: 'browser_evaluate',
    summary: 'Evaluate JavaScript in the preview’s page.',
    description:
      'Evaluate a JavaScript expression in the page in the Browser pane and return its value as ' +
      'JSON. A promise is awaited. For reading state the outline and HTML do not show.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{expression}', input: 'hidden', result: 'text' },
    async execute(input, context) {
      const expression = textOf(input.expression)
      if (!expression) return { content: 'Give an expression to evaluate.', isError: true }
      return withBrowser(browser, context, async (worktreeId) => {
        const value = await browser.evaluate(worktreeId, expression)
        return { content: describeValue(value) }
      })
    }
  }
}

/** Whether a console entry is a warning or an error. */
function isProblem(entry: BrowserConsoleEntry): boolean {
  return entry.level === 'error' || entry.level === 'warning'
}

/** Whether a request failed or came back with an error status. */
function isFailedRequest(entry: BrowserNetworkEntry): boolean {
  if (entry.error !== null) return true
  return entry.status !== null && entry.status >= 400
}

/** Console entries as lines, the newest kept when there are many. */
export function describeConsole(entries: readonly BrowserConsoleEntry[]): string {
  if (entries.length === 0) return 'Nothing logged.'
  const shown = entries.slice(-LOG_ENTRIES)
  const lines = shown.map((entry) => {
    let line = `[${entry.level}] ${entry.message}`
    if (entry.source) line += `  (${entry.source})`
    return line
  })
  return withEarlier(entries.length - shown.length, lines)
}

/** Requests as lines, the newest kept when there are many. */
export function describeNetwork(entries: readonly BrowserNetworkEntry[]): string {
  if (entries.length === 0) return 'No requests.'
  const shown = entries.slice(-LOG_ENTRIES)
  const lines = shown.map((entry) => {
    let outcome = String(entry.status)
    if (entry.error !== null) outcome = entry.error
    return `${entry.method} ${outcome} ${entry.type} ${entry.url}`
  })
  return withEarlier(entries.length - shown.length, lines)
}

/** Lines, after a note of how many earlier ones were left out. */
function withEarlier(earlier: number, lines: string[]): string {
  if (earlier <= 0) return lines.join('\n')
  return [`(${earlier} earlier entries not shown)`, ...lines].join('\n')
}

/** A value from the page as text. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 1)
}
