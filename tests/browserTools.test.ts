// The browser preview's tool: the DevTools protocol, unwrapped. It opens the
// pane when it is closed and says why when it can't be, hands screenshots back
// as images, carries what the page logged since the last call — capped — and
// runs scripts with the helpers file the model keeps in scope.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from '../src/shared/types'
import type { ShowTarget } from '../src/shared/agents'
import { browserTools, type AgentBrowser } from '../src/main/agents/tools/browserTools'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A helpers path in a directory of its own, which the test cleans up. */
function helpersPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'grove-browser-'))
  directories.push(directory)
  return join(directory, 'browser-helpers.js')
}

interface FakeBrowser extends AgentBrowser {
  sent: { method: string; params: Record<string, unknown> }[]
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
}

/** A preview that is attached once `opens` says so, answering commands from `answer`. */
function fakeBrowser(
  options: { attached: boolean; opens: boolean },
  answer: (method: string, params: Record<string, unknown>) => unknown = () => ({})
): FakeBrowser {
  let attached = options.attached
  const browser: FakeBrowser = {
    sent: [],
    console: [],
    network: [],
    isAttached: () => attached,
    waitForAttach: async () => {
      attached = options.opens
      return attached
    },
    location: () => ({ url: 'http://localhost:3100/', title: 'Demo' }),
    cdp: async (_worktreeId, method, params) => {
      browser.sent.push({ method, params })
      return answer(method, params)
    },
    consoleLog: () => [...browser.console],
    networkLog: () => [...browser.network]
  }
  return browser
}

/** A tool context that records what it was asked to show. */
function contextFor(shown: ShowTarget[] = [], sessionId = 's1'): GroveToolContext {
  return { sessionId, workspaceRoot: '/repo/worktree', surface: () => {}, show: (target) => shown.push(target) }
}

function toolOf(browser: AgentBrowser, path = helpersPath()): GroveTool {
  return browserTools(browser, { helpersPath: path })[0]
}

function consoleEntry(message: string, level = 'error'): BrowserConsoleEntry {
  return { level, message, source: '', at: 0 } as BrowserConsoleEntry
}

describe('reaching the preview', () => {
  test('a call opens the Browser pane when it is not open, then runs', async () => {
    const shown: ShowTarget[] = []
    const browser = fakeBrowser({ attached: false, opens: true })
    const result = await toolOf(browser).execute({ method: 'Page.reload' }, contextFor(shown))
    expect(shown).toEqual([{ kind: 'pane', pane: 'browser' }])
    expect(browser.sent).toEqual([{ method: 'Page.reload', params: {} }])
    expect(result.isError).toBeFalsy()
  })

  test('a pane that does not open is an error saying what to do', async () => {
    const browser = fakeBrowser({ attached: false, opens: false })
    const result = await toolOf(browser).execute({ method: 'Page.reload' }, contextFor())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Browser pane')
    expect(browser.sent).toHaveLength(0)
  })

  test('a protocol error comes back as the tool’s error', async () => {
    const browser = fakeBrowser({ attached: true, opens: true }, () => {
      throw new Error("'Nope.method' wasn't found")
    })
    const result = await toolOf(browser).execute({ method: 'Nope.method' }, contextFor())
    expect(result.isError).toBe(true)
    expect(result.content).toContain("'Nope.method' wasn't found")
  })
})

describe('what a command returns', () => {
  test('its result, as JSON, and where the page is now', async () => {
    const browser = fakeBrowser({ attached: true, opens: true }, () => ({ result: { type: 'number', value: 42 } }))
    const result = await toolOf(browser).execute(
      { method: 'Runtime.evaluate', params: { expression: '6 * 7', returnByValue: true } },
      contextFor()
    )
    expect(browser.sent[0].params).toEqual({ expression: '6 * 7', returnByValue: true })
    expect(result.content).toStartWith('{"result":{"type":"number","value":42}}')
    expect(result.content).toContain('Now at http://localhost:3100/')
  })

  test('a screenshot goes back as an image, not as base64 text', async () => {
    const browser = fakeBrowser({ attached: true, opens: true }, () => ({ data: 'iVBORw0KGgo=' }))
    const result = await toolOf(browser).execute({ method: 'Page.captureScreenshot' }, contextFor())
    expect(result.images).toEqual([{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
    expect(result.content).not.toContain('iVBORw0KGgo=')
  })

  test('a huge result is cut, and says so', async () => {
    const browser = fakeBrowser({ attached: true, opens: true }, () => ({ html: 'x'.repeat(50000) }))
    const result = await toolOf(browser).execute({ method: 'DOM.getOuterHTML' }, contextFor())
    expect(result.content.length).toBeLessThan(21000)
    expect(result.content).toContain('[Cut at 20000')
  })
})

describe('what the page logged', () => {
  test('each reply carries only what is new since the session’s last call', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    const tool = toolOf(browser)
    browser.console.push(consoleEntry('Uncaught ReferenceError: missingFunction'))
    const first = await tool.execute({ method: 'Page.reload' }, contextFor())
    expect(first.content).toContain('missingFunction')

    const second = await tool.execute({ method: 'Page.reload' }, contextFor())
    expect(second.content).not.toContain('missingFunction')

    browser.console.push(consoleEntry('later'))
    const third = await tool.execute({ method: 'Page.reload' }, contextFor())
    expect(third.content).toContain('later')
    expect(third.content).not.toContain('missingFunction')
  })

  test('only failed requests are reported', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    browser.network.push(
      { method: 'GET', url: 'http://localhost:3100/', status: 200, type: 'mainFrame', error: null, at: 0 },
      { method: 'GET', url: 'http://localhost:3100/missing.json', status: 404, type: 'xhr', error: null, at: 1 }
    )
    const result = await toolOf(browser).execute({ method: 'Page.reload' }, contextFor())
    expect(result.content).toContain('missing.json → 404')
    expect(result.content).not.toContain('mainFrame')
  })

  test('a chatty page is capped in entries and line length', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    for (let index = 0; index < 50; index++) browser.console.push(consoleEntry(`message ${index} ${'y'.repeat(500)}`, 'log'))
    const result = await toolOf(browser).execute({ method: 'Page.reload' }, contextFor())
    expect(result.content).toContain('[40 earlier left out]')
    expect(result.content).toContain('message 49')
    expect(result.content).not.toContain('message 39 ')
    const longest = Math.max(...result.content.split('\n').map((line) => line.length))
    expect(longest).toBeLessThanOrEqual(200)
  })
})

describe('scripts and helpers', () => {
  test('a script runs with cdp and the starter helpers, which are written on first use', async () => {
    const path = helpersPath()
    const browser = fakeBrowser({ attached: true, opens: true }, (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'complete' } }
      return {}
    })
    const result = await toolOf(browser, path).execute(
      { script: 'await clickAt(10, 20); return await evaluate("document.readyState")' },
      contextFor()
    )
    expect(result.content).toStartWith('"complete"')
    expect(browser.sent.map((sent) => sent.params.type).filter(Boolean)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased'
    ])
    expect(readFileSync(path, 'utf8')).toContain('async function clickAt')
  })

  test('a helper the model added is in scope', async () => {
    const path = helpersPath()
    writeFileSync(path, 'async function double(value) { return value * 2 }\n')
    const result = await toolOf(fakeBrowser({ attached: true, opens: true }), path).execute(
      { script: 'return double(21)' },
      contextFor()
    )
    expect(result.content).toStartWith('42')
  })

  test('a broken helpers file says which file to fix', async () => {
    const path = helpersPath()
    writeFileSync(path, 'async function broken( {\n')
    const result = await toolOf(fakeBrowser({ attached: true, opens: true }), path).execute(
      { script: 'return 1' },
      contextFor()
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(`Fix ${path}`)
  })

  test('a script cannot reach node', async () => {
    const result = await toolOf(fakeBrowser({ attached: true, opens: true })).execute(
      { script: 'return typeof require + typeof process' },
      contextFor()
    )
    expect(result.content).toStartWith('"undefinedundefined"')
  })
})
