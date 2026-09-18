// The half of the QA harness that touches the app, over the Chrome DevTools
// Protocol port the session was launched with.
//
// This file runs under **node**, not bun: `connectOverCDP` never completes its
// websocket handshake under bun, and hangs until Playwright's own timeout. It
// is therefore kept free of repo imports beyond `targets.ts`, so nothing pulls
// bun-resolved module specifiers in behind it.
//
// It is invoked once per action and keeps nothing in memory between calls — the
// session lives in files under `.grove-test/qa`. Refs handed out by `probe` are
// the one thing that has to survive, and they do so as selectors on disk.
//
//   node scripts/qa/drive.ts <port> <refsPath> '<commandJson>'

import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
import { parseTarget, describeTarget, NAME_ROLES, type Target } from './targets.ts'

interface Command {
  action: string
  [key: string]: unknown
}

interface ProbeEntry {
  ref: string
  role: string
  name: string
  selector: string
  box: { x: number; y: number; width: number; height: number }
  disabled?: boolean
}

async function main(): Promise<void> {
  const [portArg, refsPath, commandJson] = process.argv.slice(2)
  if (!portArg || !refsPath || !commandJson) {
    throw new Error('usage: drive.ts <port> <refsPath> <commandJson>')
  }
  const command: Command = JSON.parse(commandJson)
  const browser = await connect(Number(portArg))
  const page = await rendererPage(browser)

  const result = await run(page, refsPath, command)
  console.log(JSON.stringify(result ?? { ok: true }, null, 2))
  // Not `browser.close()`: for a CDP connection that closes the app itself.
  process.exit(0)
}

/**
 * Run one command, and photograph the result if it asked for that.
 *
 * Same connection, deliberately: a menu opened by a click can close again when
 * the driver disconnects, and a screenshot taken by the next invocation would
 * show a screen the action never produced.
 */
async function run(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const result = await perform(page, refsPath, command)
  if (typeof command.shot !== 'string') return result
  await page.screenshot({ path: command.shot })
  return { ...(result as Record<string, unknown>), shot: command.shot }
}

async function perform(page: Page, refsPath: string, command: Command): Promise<unknown> {
  if (command.action === 'ready') return ready(page, Number(command.timeout ?? 60_000))
  if (command.action === 'state') return state(page)
  if (command.action === 'console') return consoleLog(page)
  if (command.action === 'probe') return probe(page, refsPath, command)
  if (command.action === 'shot') return shot(page, refsPath, command)
  if (command.action === 'click') return click(page, refsPath, command)
  if (command.action === 'drag') return drag(page, refsPath, command)
  if (command.action === 'type') return type(page, command)
  if (command.action === 'key') return key(page, command)
  if (command.action === 'scroll') return scroll(page, refsPath, command)
  if (command.action === 'wait') return wait(page, refsPath, command)
  if (command.action === 'eval') return evaluate(page, command)
  throw new Error(`unknown action: ${command.action}`)
}

// ---------------------------------------------------------------- connecting

async function connect(port: number): Promise<Browser> {
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 })
}

/**
 * The window the app is in.
 *
 * Electron exposes every WebContents as a page, which includes any devtools
 * that happen to be open; grove's own renderer is the one serving index.html.
 */
async function rendererPage(browser: Browser): Promise<Page> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url().includes('index.html')) return page
    }
  }
  throw new Error('no grove window is open on this CDP port')
}

// ------------------------------------------------------------------- waiting

/**
 * Wait until the app is worth driving, and clear what is in the way.
 *
 * The window exists well before the repo does — opening it is git work the main
 * process does after the renderer has painted — and the first-run wizard covers
 * the whole centre pane while it is up.
 */
async function ready(page: Page, timeout: number): Promise<unknown> {
  await page.waitForFunction(
    () => Boolean((window as never as GroveWindow).__grove_debug?.store?.selectedWorktree?.path),
    undefined,
    { timeout }
  )
  await installConsoleCapture(page)

  const notNow = page.getByRole('button', { name: 'Not now' })
  const dismissed = await notNow.isVisible().catch(() => false)
  if (dismissed) await notNow.click()

  return { ready: true, dismissedSetup: dismissed, ...(await state(page)) }
}

// --------------------------------------------------------------------- state

/** What is on screen right now, as far as the renderer's own stores know. */
async function state(page: Page): Promise<Record<string, unknown>> {
  await installConsoleCapture(page)
  return page.evaluate(() => {
    const debug = (window as never as GroveWindow).__grove_debug
    if (!debug) return { error: 'renderer debug hooks missing — was GROVE_DEBUG set?' }
    return {
      worktree: debug.store?.selectedWorktree?.path,
      activeTab: debug.store?.activeTabPath,
      activePane: debug.keymap?.activePane,
      panes: debug.layout?.leafSummary ? debug.layout.leafSummary() : undefined,
      agentSessions: (debug.agentSessions?.list ?? []).map((session) => ({
        id: session.id,
        status: session.status
      })),
      reviewQueue: (debug.review?.queue ?? []).length,
      storeError: debug.store?.error,
      consoleErrors: ((window as never as QaWindow).__qa_console ?? []).filter(
        (entry) => entry.level === 'error'
      ).length
    }
  })
}

/** Everything the renderer has logged since the capture went in. */
async function consoleLog(page: Page): Promise<unknown> {
  await installConsoleCapture(page)
  return page.evaluate(() => (window as never as QaWindow).__qa_console ?? [])
}

/**
 * Keep the renderer's console in a ring buffer on `window`.
 *
 * Playwright's own `page.on('console')` only reports what is logged while a
 * connection is open, and this driver connects for one action at a time. A
 * buffer in the page outlives the connection, which is what makes "what did it
 * complain about while I was not looking" answerable at all.
 */
async function installConsoleCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = window as never as QaWindow
    if (view.__qa_console) return
    const entries: QaConsoleEntry[] = []
    view.__qa_console = entries

    const record = (level: string, args: unknown[]): void => {
      entries.push({
        level,
        at: new Date().toISOString(),
        text: args
          .map((arg) => {
            if (typeof arg === 'string') return arg
            try {
              return JSON.stringify(arg)
            } catch {
              return String(arg)
            }
          })
          .join(' ')
      })
      if (entries.length > 500) entries.splice(0, entries.length - 500)
    }

    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      const original = console[level].bind(console)
      console[level] = (...args: unknown[]): void => {
        record(level, args)
        original(...args)
      }
    }
    window.addEventListener('error', (event) => record('error', [event.message]))
    window.addEventListener('unhandledrejection', (event) =>
      record('error', ['unhandled rejection:', (event as PromiseRejectionEvent).reason])
    )
  })
}

// --------------------------------------------------------------------- probe

/**
 * Everything on screen that can be acted on, with a ref to act on it by.
 *
 * A model reading a screenshot can see a button and still be a dozen pixels out
 * when it clicks; naming what it saw is exact. Refs are written to disk so the
 * next invocation of this driver can resolve them, and they are only valid
 * until the screen changes under them — a stale one is an error, not a miss.
 */
async function probe(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const filter = typeof command.filter === 'string' ? command.filter.toLowerCase() : null
  const entries = await page.evaluate<ProbeEntry[]>(probeScript)

  const matched = filter
    ? entries.filter(
        (entry) => entry.name.toLowerCase().includes(filter) || entry.role.includes(filter)
      )
    : entries

  writeFileSync(refsPath, JSON.stringify(matched, null, 2), 'utf8')
  return {
    count: matched.length,
    elements: matched.map((entry) => {
      const grab = grabPoint(entry.box)
      return {
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        disabled: entry.disabled,
        at: `${Math.round(grab.x)},${Math.round(grab.y)}`,
        size: `${Math.round(entry.box.width)}x${Math.round(entry.box.height)}`
      }
    })
  }
}

/**
 * Collect the interactive elements in the page, in reading order.
 *
 * Serialised into the renderer, so it stands alone — nothing here may close
 * over anything in this module.
 */
const probeScript = (): ProbeEntry[] => {
  const SELECTOR = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role=button]',
    '[role=tab]',
    '[role=treeitem]',
    '[role=menuitem]',
    '[role=menuitemcheckbox]',
    '[role=menuitemradio]',
    '[role=option]',
    '[role=row]',
    '[role=gridcell]',
    '[role=combobox]',
    '[role=switch]',
    '[role=separator]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=textbox]',
    '[contenteditable=true]',
    '[data-testid]',
    'canvas'
  ].join(',')

  /** A selector that picks this one element out again, as a path from the root. */
  const selectorFor = (element: Element): string => {
    const steps: string[] = []
    let current: Element | null = element
    while (current && current !== document.documentElement) {
      const node: Element = current
      const parent: Element | null = node.parentElement
      if (!parent) break
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === node.tagName
      )
      const index = siblings.indexOf(node) + 1
      steps.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`)
      current = parent
    }
    return steps.join(' > ')
  }

  const nameOf = (element: Element): string => {
    const label = element.getAttribute('aria-label')
    if (label) return label.trim()
    const title = element.getAttribute('title')
    if (title) return title.trim()
    const placeholder = element.getAttribute('placeholder')
    if (placeholder) return placeholder.trim()
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 80)
    const testId = element.getAttribute('data-testid')
    if (testId) return testId
    return ''
  }

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'input') return element.getAttribute('type') ?? 'textbox'
    if (tag === 'textarea') return 'textbox'
    return tag
  }

  const entries: ProbeEntry[] = []
  let next = 1

  for (const element of Array.from(document.querySelectorAll(SELECTOR))) {
    const box = element.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) continue
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') continue

    const entry: ProbeEntry = {
      ref: `e${next}`,
      role: roleOf(element),
      name: nameOf(element),
      selector: selectorFor(element),
      box: { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    if (element.hasAttribute('disabled')) entry.disabled = true
    entries.push(entry)
    next += 1
  }
  return entries
}

// ------------------------------------------------------------------ resolving

function readRefs(refsPath: string): ProbeEntry[] {
  try {
    return JSON.parse(readFileSync(refsPath, 'utf8'))
  } catch {
    return []
  }
}

/** The element a target names, as a Playwright locator. */
function locate(page: Page, refsPath: string, target: Target): Locator {
  if (target.kind === 'ref') {
    const entry = readRefs(refsPath).find((candidate) => candidate.ref === target.ref)
    if (!entry) throw new Error(`no such ref: ${target.ref} — run "qa probe" again`)
    return page.locator(entry.selector)
  }
  if (target.kind === 'css') return page.locator(target.selector)
  if (target.kind === 'testid') return page.getByTestId(target.testId)
  if (target.kind === 'text') return page.getByText(target.text).first()
  if (target.kind === 'name') {
    if (target.role !== undefined) {
      return page.getByRole(target.role as never, { name: target.name }).first()
    }
    // A bare name is what the screen reads as; try the roles a person clicks.
    const roles = NAME_ROLES.map((role) => `[role="${role}"]`).join(',')
    return page
      .getByRole('button', { name: target.name })
      .or(page.locator(roles, { hasText: target.name }))
      .or(page.getByText(target.name, { exact: true }))
      .first()
  }
  throw new Error(`${describeTarget(target)} is a point, not an element`)
}

/** Where in the window a target is, for the actions that need coordinates. */
async function pointOf(
  page: Page,
  refsPath: string,
  target: Target
): Promise<{ x: number; y: number }> {
  if (target.kind === 'point') return { x: target.x, y: target.y }
  const box = await locate(page, refsPath, target).boundingBox({ timeout: 10_000 })
  if (!box) throw new Error(`${describeTarget(target)} is not on screen`)
  return grabPoint(box)
}

/**
 * Where to take hold of an element.
 *
 * The middle, except for something long and thin — a pane divider — which is
 * where grove mounts the `+` that opens a pane in the gap. Pressing there opens
 * the picker instead of starting a drag, which is exactly right for a person
 * and useless for resizing. A person grabs a divider anywhere along it; so does
 * this.
 */
function grabPoint(box: { x: number; y: number; width: number; height: number }): {
  x: number
  y: number
} {
  const LONG_AND_THIN = 4
  if (box.height > box.width * LONG_AND_THIN) {
    return { x: box.x + box.width / 2, y: box.y + box.height * 0.25 }
  }
  if (box.width > box.height * LONG_AND_THIN) {
    return { x: box.x + box.width * 0.25, y: box.y + box.height / 2 }
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// ------------------------------------------------------------------- actions

async function click(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const target = parseTarget(String(command.target))
  const button = (command.button as 'left' | 'right' | 'middle') ?? 'left'
  const clickCount = Number(command.count ?? 1)

  if (target.kind === 'point') {
    await page.mouse.click(target.x, target.y, { button, clickCount })
    return { clicked: describeTarget(target) }
  }
  const locator = locate(page, refsPath, target)
  await locator.click({ button, clickCount, timeout: 15_000 })
  return { clicked: describeTarget(target) }
}

/**
 * Press, move, release — the way a person resizes a pane.
 *
 * The move is stepped rather than a jump: a divider listens to pointermove and
 * accumulates deltas, and one event from start to finish is a drag it never
 * sees the middle of.
 */
async function drag(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const from = await pointOf(page, refsPath, parseTarget(String(command.from)))
  const to = await pointOf(page, refsPath, parseTarget(String(command.to)))
  const steps = Number(command.steps ?? 24)

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)
  }
  await page.mouse.up()
  return { dragged: `${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)}` }
}

/** Type into whatever has focus, a keystroke at a time. */
async function type(page: Page, command: Command): Promise<unknown> {
  const text = String(command.text)
  await page.keyboard.type(text, { delay: Number(command.delay ?? 20) })
  return { typed: text.length }
}

/** Press keys or chords in order: `Escape`, `Control+s`, `g g`. */
async function key(page: Page, command: Command): Promise<unknown> {
  const keys = Array.isArray(command.keys) ? (command.keys as string[]) : [String(command.keys)]
  for (const chord of keys) {
    await page.keyboard.press(chord, { delay: Number(command.delay ?? 20) })
  }
  return { pressed: keys }
}

async function scroll(page: Page, refsPath: string, command: Command): Promise<unknown> {
  if (command.target !== undefined) {
    const point = await pointOf(page, refsPath, parseTarget(String(command.target)))
    await page.mouse.move(point.x, point.y)
  }
  const deltaX = Number(command.dx ?? 0)
  const deltaY = Number(command.dy ?? 0)
  await page.mouse.wheel(deltaX, deltaY)
  return { scrolled: { deltaX, deltaY } }
}

/** Wait for a target to appear, or to go away. */
async function wait(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const target = parseTarget(String(command.target))
  const gone = command.gone === true
  const timeout = Number(command.timeout ?? 20_000)
  await locate(page, refsPath, target).waitFor({
    state: gone ? 'hidden' : 'visible',
    timeout
  })
  return { [gone ? 'gone' : 'visible']: describeTarget(target) }
}

async function evaluate(page: Page, command: Command): Promise<unknown> {
  const expression = String(command.expression)
  // Mirrors debug.renderer.eval: an expression, awaited, JSON on the way out —
  // Svelte's $state values are Proxies and do not survive structured cloning.
  const json = await page.evaluate<string | null>(
    `Promise.resolve((() => (${expression}))()).then((value) => JSON.stringify(value === undefined ? null : value))`
  )
  if (json === null || json === undefined) return null
  return JSON.parse(json)
}

async function shot(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const path = String(command.path)
  if (command.target !== undefined) {
    const locator = locate(page, refsPath, parseTarget(String(command.target)))
    await locator.screenshot({ path })
    return { shot: path, of: String(command.target) }
  }
  await page.screenshot({ path })
  return { shot: path }
}

// The shapes this driver reaches for on `window`. Only what is used is
// declared; the renderer's own globals are typed for its build, not this one.
interface QaConsoleEntry {
  level: string
  at: string
  text: string
}

interface QaWindow {
  __qa_console?: QaConsoleEntry[]
}

interface GroveWindow {
  __grove_debug?: {
    store?: { selectedWorktree?: { path: string }; activeTabPath?: string; error?: string }
    keymap?: { activePane?: string }
    layout?: { leafSummary?(): unknown }
    review?: { queue?: unknown[] }
    agentSessions?: { list?: Array<{ id: string; status: string }> }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message.split('\n').slice(0, 6).join('\n'))
  process.exit(1)
})
