// The browser preview's agent tools: they open the pane when it is closed, say
// why when it can't be, hand pictures back as images, and read the logs.

import { describe, expect, mock, test } from 'bun:test'
import type { GroveToolContext } from '../src/main/agents/harness'
import type { ShowTarget } from '../src/shared/agents'
import {
  browserTools,
  clickTarget,
  describeConsole,
  describeNetwork,
  type AgentBrowser
} from '../src/main/agents/tools/browserTools'
import { resultContent } from '../src/main/agents/switchboard/mcpServer'

/** A preview that is attached once `opens` says so. */
function fakeBrowser(options: { attached: boolean; opens: boolean }): AgentBrowser & { clicked: unknown[] } {
  let attached = options.attached
  const clicked: unknown[] = []
  return {
    clicked,
    isAttached: () => attached,
    waitForAttach: async () => {
      attached = options.opens
      return attached
    },
    location: () => ({ url: 'http://localhost:3100/', title: 'Demo' }),
    navigate: async () => {},
    snapshot: async () => ({ elements: [] }),
    screenshot: async () => 'iVBORw0KGgo=',
    html: async () => '<main></main>',
    evaluate: async () => ({ answer: 42 }),
    click: async (_worktreeId, target) => {
      clicked.push(target)
      return '10,20'
    },
    type: async () => {},
    press: async () => {},
    consoleLog: () => [
      { level: 'info', message: 'ready', source: '', at: 0 },
      { level: 'error', message: 'Uncaught ReferenceError: missingFunction is not defined', source: 'http://localhost:3100/:9', at: 1 }
    ],
    networkLog: () => [
      { method: 'GET', url: 'http://localhost:3100/', status: 200, type: 'mainFrame', error: null, at: 0 },
      { method: 'GET', url: 'http://localhost:3100/missing.json', status: 404, type: 'xhr', error: null, at: 1 }
    ],
    clearConsole: () => {},
    clearNetwork: () => {}
  }
}

/** A tool context that records what it was asked to show. */
function contextFor(shown: ShowTarget[]): GroveToolContext {
  return {
    sessionId: 's1',
    workspaceRoot: '/repo/worktree',
    surface: () => {},
    show: (target) => shown.push(target)
  }
}

/** One tool by name. */
function toolNamed(browser: AgentBrowser, name: string) {
  const tool = browserTools(browser).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

describe('reaching the preview', () => {
  test('a call opens the Browser pane when it is not open, then runs', async () => {
    const shown: ShowTarget[] = []
    const browser = fakeBrowser({ attached: false, opens: true })
    const result = await toolNamed(browser, 'browser_click').execute({ selector: '#save' }, contextFor(shown))
    expect(shown).toEqual([{ kind: 'pane', pane: 'browser' }])
    expect(result.isError).toBeUndefined()
    expect(browser.clicked).toEqual([{ selector: '#save' }])
  })

  test('a pane that does not open is an error saying what to do', async () => {
    const browser = fakeBrowser({ attached: false, opens: false })
    const result = await toolNamed(browser, 'browser_snapshot').execute({}, contextFor([]))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Ask them to open the Browser pane')
  })

  test('an open pane is used as it is', async () => {
    const shown: ShowTarget[] = []
    const browser = fakeBrowser({ attached: true, opens: true })
    await toolNamed(browser, 'browser_navigate').execute({ url: 'http://localhost:3100/' }, contextFor(shown))
    expect(shown).toEqual([])
  })

  test('a failure in the page comes back as the tool’s error', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    browser.click = mock(async () => {
      throw new Error('No element matches #nope.')
    })
    const result = await toolNamed(browser, 'browser_click').execute({ selector: '#nope' }, contextFor([]))
    expect(result).toEqual({ content: 'No element matches #nope.', isError: true })
  })
})

describe('what the tools return', () => {
  test('a screenshot goes back to the harness as an image beside its text', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    const result = await toolNamed(browser, 'browser_screenshot').execute({}, contextFor([]))
    const content = resultContent(result)
    expect(content[0].type).toBe('text')
    expect(content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
  })

  test('errors only keeps the console’s errors and warnings', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    const result = await toolNamed(browser, 'browser_console').execute({ errorsOnly: true }, contextFor([]))
    expect(result.content).toBe(
      '[error] Uncaught ReferenceError: missingFunction is not defined  (http://localhost:3100/:9)'
    )
  })

  test('failed only keeps error statuses and failed requests', async () => {
    const browser = fakeBrowser({ attached: true, opens: true })
    const result = await toolNamed(browser, 'browser_network').execute({ failedOnly: true }, contextFor([]))
    expect(result.content).toBe('GET 404 xhr http://localhost:3100/missing.json')
  })

  test('long logs keep the newest entries and say how many were left out', () => {
    const entries = Array.from({ length: 85 }, (_, index) => ({
      level: 'info',
      message: `line ${index}`,
      source: '',
      at: index
    }))
    const text = describeConsole(entries)
    expect(text.startsWith('(5 earlier entries not shown)')).toBe(true)
    expect(text.endsWith('[info] line 84')).toBe(true)
    expect(describeNetwork([])).toBe('No requests.')
  })
})

describe('what a click aims at', () => {
  test('a selector, else a point, else nothing', () => {
    expect(clickTarget({ selector: ' #save ' })).toEqual({ selector: '#save' })
    expect(clickTarget({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
    expect(clickTarget({ x: 10 })).toBeNull()
  })
})
