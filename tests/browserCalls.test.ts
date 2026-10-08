// Reading a `browser` call back as what it did in the page: the action its
// input describes, and its reply taken apart into value, log and location. The
// replies are produced by the tool itself, so the parsing follows what the model
// is actually sent.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from '../src/shared/types'
import { browserTools, type AgentBrowser } from '../src/main/agents/tools/browserTools'
import {
  browserActionOf,
  browserReplyOf,
  logHasErrors,
  valueOf
} from '../src/renderer/src/lib/agents/browserCalls'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface FakePage extends AgentBrowser {
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
}

/** An attached preview that answers every command from `answer`. */
function fakePage(answer: (method: string) => unknown, title = 'Demo'): FakePage {
  const page: FakePage = {
    console: [],
    network: [],
    isAttached: () => true,
    location: () => ({ url: 'http://localhost:3100/todos', title }),
    cdp: async (_worktreeId, method) => answer(method),
    consoleLog: () => [...page.console],
    networkLog: () => [...page.network]
  }
  return page
}

/** The reply text the tool gives the model for one call. */
async function replyText(page: AgentBrowser, input: Record<string, unknown>): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'grove-browser-calls-'))
  directories.push(directory)
  const helpersPath = join(directory, 'helpers.js')
  const tool = browserTools(page, { helpersPath })[0]
  const context = { sessionId: 's1', workspaceRoot: '/repo', surface: () => {}, show: () => {} }
  const result = await tool.execute(input, context)
  return result.content
}

describe('the action a call was', () => {
  test('a navigation reads as its URL', () => {
    const action = browserActionOf({ method: 'Page.navigate', params: { url: 'http://localhost:3100/' } })
    expect(action.verb).toBe('navigate')
    expect(action.detail).toBe('http://localhost:3100/')
  })

  test('a mouse press reads as a click at its point', () => {
    const action = browserActionOf({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 120, y: 48, button: 'left', clickCount: 1 }
    })
    expect(action.verb).toBe('click')
    expect(action.detail).toBe('120, 48')
  })

  test('inserted text reads as typing it, and a key event as the key', () => {
    expect(browserActionOf({ method: 'Input.insertText', params: { text: 'buy milk' } })).toMatchObject({
      verb: 'type',
      detail: 'buy milk'
    })
    expect(
      browserActionOf({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' } })
    ).toMatchObject({ verb: 'key', detail: 'Enter' })
  })

  test('an evaluation and a script carry their code', () => {
    const evaluate = browserActionOf({ method: 'Runtime.evaluate', params: { expression: 'document.title' } })
    expect(evaluate).toMatchObject({ kind: 'evaluate', code: 'document.title' })
    const script = browserActionOf({ script: '\nawait click("#add")\nreturn 1' })
    expect(script).toMatchObject({ kind: 'script', detail: 'await click("#add")', method: '' })
  })

  test('any other method keeps its name and its params', () => {
    const action = browserActionOf({ method: 'DOM.getDocument', params: { depth: 1 } })
    expect(action).toMatchObject({ kind: 'other', verb: 'DOM.getDocument', params: { depth: 1 } })
  })
})

describe('a reply taken apart', () => {
  test('an evaluation: the value it returned and where the page is', async () => {
    const page = fakePage(() => ({ result: { type: 'number', value: 42 } }))
    const input = { method: 'Runtime.evaluate', params: { expression: '6 * 7', returnByValue: true } }
    const reply = browserReplyOf(await replyText(page, input))
    expect(reply.url).toBe('http://localhost:3100/todos')
    expect(reply.title).toBe('Demo')
    expect(reply.console).toEqual([])
    expect(valueOf(browserActionOf(input), reply)).toEqual({ text: '42', isError: false })
  })

  test('a page with no title still gives its URL', async () => {
    const reply = browserReplyOf(await replyText(fakePage(() => ({}), ''), { method: 'Page.reload' }))
    expect(reply.url).toBe('http://localhost:3100/todos')
    expect(reply.title).toBe('')
    expect(valueOf(browserActionOf({ method: 'Page.reload' }), reply).text).toBe('')
  })

  test('an exception in the page reads as an error', async () => {
    const page = fakePage(() => ({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined' } }
    }))
    const input = { method: 'Runtime.evaluate', params: { expression: 'nope' } }
    const value = valueOf(browserActionOf(input), browserReplyOf(await replyText(page, input)))
    expect(value).toEqual({ text: 'ReferenceError: nope is not defined', isError: true })
  })

  test('the page’s log: console lines, failed requests, and what was left out', async () => {
    const page = fakePage(() => ({}))
    for (let index = 0; index < 12; index++) {
      page.console.push({ level: 'info', message: `line ${index}`, source: '', at: 0 })
    }
    page.console.push({ level: 'error', message: 'Boom', source: 'app.js:3', at: 0 })
    page.network.push({ method: 'GET', url: 'http://localhost:3100/api', status: 500 } as BrowserNetworkEntry)
    const reply = browserReplyOf(await replyText(page, { method: 'Page.reload' }))
    expect(reply.leftOut).toBe(3)
    expect(reply.console).toHaveLength(10)
    expect(reply.console[9]).toEqual({ text: 'error: Boom (app.js:3)', isError: true })
    expect(reply.console[0].isError).toBe(false)
    expect(reply.failedRequests).toEqual([{ text: 'GET http://localhost:3100/api → 500', isError: true }])
    expect(reply.url).toBe('http://localhost:3100/todos')
    expect(logHasErrors(reply)).toBe(true)
  })

  test('a log of only info lines has no errors', async () => {
    const page = fakePage(() => ({}))
    page.console.push({ level: 'info', message: 'ready', source: '', at: 0 })
    const reply = browserReplyOf(await replyText(page, { method: 'Page.reload' }))
    expect(reply.console).toEqual([{ text: 'info: ready', isError: false }])
    expect(logHasErrors(reply)).toBe(false)
  })

  test('a script’s return value, ahead of the log', async () => {
    const page = fakePage(() => ({}))
    page.console.push({ level: 'warning', message: 'slow', source: '', at: 0 })
    const input = { script: 'return { added: 2 }' }
    const reply = browserReplyOf(await replyText(page, input))
    expect(valueOf(browserActionOf(input), reply).text).toBe('{"added":2}')
    expect(reply.console).toHaveLength(1)
  })

  test('a protocol error is the value, with the page’s location after it', async () => {
    const page = fakePage(() => {
      throw new Error("'Nope.method' wasn't found")
    })
    const reply = browserReplyOf(await replyText(page, { method: 'Nope.method' }))
    expect(reply.value).toBe("'Nope.method' wasn't found")
    expect(reply.url).toBe('http://localhost:3100/todos')
  })

  test('text that is not a browser reply is all value', () => {
    expect(browserReplyOf('Give a protocol method, e.g. "Page.navigate", or a script.')).toMatchObject({
      value: 'Give a protocol method, e.g. "Page.navigate", or a script.',
      url: ''
    })
  })
})
