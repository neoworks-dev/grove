// What a QA action does, shared by the live driver and the specs it records.
//
// `qa click` and a replayed repro must do the same thing, or a repro that
// passes proves nothing about the session it was recorded from. So everything
// Playwright has no one-liner for — a stepped drag, a pane opened through the
// debug hooks, the checks `qa expect` makes — lives here, and both `drive.ts`
// and every `tests/e2e/repro/*.e2e.ts` call it.
//
// Runs under node (from `drive.ts`) and under Playwright's test loader (from a
// spec), so it imports nothing but Playwright and uses no bun or ESM-only API.

import type { ElectronApplication, Locator, Page } from '@playwright/test'

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** What a check found: whether the app did the right thing, and what it saw. */
export interface CheckResult {
  passed: boolean
  detail: string
}

/** How a pane is opened, moved or closed — the `qa pane` request. */
export interface PaneRequest {
  paneTypeId: string
  close?: boolean
  split?: 'row' | 'column' | null
  // The type of the pane to swap into, rather than its leaf id: leaf ids are
  // handed out as panes open, and a replay on a fresh profile numbers them anew.
  inPaneType?: string | null
}

// ------------------------------------------------------------------ starting

/**
 * Put a replay where the recording started: the same window size, and the
 * renderer's console captured so `noErrors` has something to read.
 */
export async function begin(
  electron: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await installConsoleCapture(page)
  await electron.evaluate(({ BrowserWindow }, wanted) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(wanted.width, wanted.height)
  }, size)
  await page.waitForFunction(
    (wanted) => window.innerWidth === wanted.width && window.innerHeight === wanted.height,
    size,
    { timeout: 5_000 }
  )
}

/**
 * Keep the renderer's console in a ring buffer on `window`.
 *
 * Playwright's own `page.on('console')` only reports what is logged while a
 * connection is open, and the live driver connects for one action at a time. A
 * buffer in the page outlives the connection, which is what makes "what did it
 * complain about while I was not looking" answerable at all.
 */
export async function installConsoleCapture(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const view = window as never as QaWindow
      if (view.__qa_console) return
      const entries: QaConsoleEntry[] = []
      view.__qa_console = entries

      // Also the way the CDP drain gets its entries in here, which is why it
      // lives on `window` rather than staying local.
      const record = (level: string, text: string): void => {
        // The same fault often arrives twice — `window.onerror` and CDP's
        // exception report are the same throw — so a repeat of the last line
        // within a second is dropped rather than counted again.
        const last = entries[entries.length - 1]
        const now = Date.now()
        if (last && last.level === level && last.text === text && now - last.atMs < 1000) return
        entries.push({ level, at: new Date(now).toISOString(), atMs: now, text })
        if (entries.length > 500) entries.splice(0, entries.length - 500)
      }
      view.__qa_record = record

      const format = (args: unknown[]): string =>
        args
          .map((arg) => {
            if (typeof arg === 'string') return arg
            try {
              return JSON.stringify(arg)
            } catch {
              return String(arg)
            }
          })
          .join(' ')

      for (const level of ['log', 'info', 'warn', 'error'] as const) {
        const original = console[level].bind(console)
        console[level] = (...args: unknown[]): void => {
          record(level, format(args))
          original(...args)
        }
      }
      window.addEventListener('error', (event) => record('error', event.message))
      window.addEventListener('unhandledrejection', (event) =>
        record('error', `unhandled rejection: ${format([(event as PromiseRejectionEvent).reason])}`)
      )
    })
    .catch(() => undefined)
}

// ------------------------------------------------------------------- actions

/**
 * Where to take hold of an element.
 *
 * The middle, except for something long and thin — a pane divider — which is
 * where grove mounts the `+` that opens a pane in the gap. Pressing there opens
 * the picker instead of starting a drag, which is exactly right for a person
 * and useless for resizing. A person grabs a divider anywhere along it; so does
 * this.
 */
export function grabPoint(box: Box): Point {
  const LONG_AND_THIN = 4
  if (box.height > box.width * LONG_AND_THIN) {
    return { x: box.x + box.width / 2, y: box.y + box.height * 0.25 }
  }
  if (box.width > box.height * LONG_AND_THIN) {
    return { x: box.x + box.width * 0.25, y: box.y + box.height / 2 }
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** The point to press on: the given one, or where to grab an element. */
export async function pointOf(target: Locator | Point): Promise<Point> {
  if (!isLocator(target)) return target
  const box = await target.boundingBox({ timeout: 10_000 })
  if (!box) throw new Error(`${target} is not on screen`)
  return grabPoint(box)
}

/**
 * Press, move, release — the way a person resizes a pane.
 *
 * The move is stepped rather than a jump: a divider listens to pointermove and
 * accumulates deltas, and one event from start to finish is a drag it never
 * sees the middle of.
 */
export async function drag(
  page: Page,
  fromTarget: Locator | Point,
  toTarget: Locator | Point,
  steps = 24
): Promise<{ from: Point; to: Point }> {
  const from = await pointOf(fromTarget)
  const to = await pointOf(toTarget)

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)
  }
  await page.mouse.up()
  return { from, to }
}

/** Wheel, over a target when one is given and wherever the mouse is otherwise. */
export async function scroll(
  page: Page,
  target: Locator | Point | null,
  deltaY: number
): Promise<void> {
  if (target !== null) {
    const point = await pointOf(target)
    await page.mouse.move(point.x, point.y)
  }
  await page.mouse.wheel(0, deltaY)
}

/**
 * Open, move or close a pane by type, the way a command would.
 *
 * The point is not to skip the UI but to stop paying for it: finding the gutter
 * that opens a GitHub pane takes an agent a dozen actions, and none of them are
 * what it was sent to test.
 */
export async function pane(page: Page, request: PaneRequest): Promise<Record<string, unknown>> {
  const options = {
    paneTypeId: request.paneTypeId,
    close: request.close === true,
    split: request.split ?? null,
    inPaneType: request.inPaneType ?? null
  }
  const outcome = await page.evaluate((wanted) => {
    const debug = (window as never as GroveWindow).__grove_debug
    const layout = debug?.layout
    const panes = debug?.panes
    if (!layout || !panes) return { error: 'renderer debug hooks missing — was GROVE_DEBUG set?' }
    if (!panes.get(wanted.paneTypeId)) {
      return {
        error: `no such pane type: ${wanted.paneTypeId}`,
        available: panes.types.map((type) => type.id).sort()
      }
    }

    if (wanted.close) {
      const open = layout.leafSummary().filter((leaf) => leaf.paneTypeId === wanted.paneTypeId)
      if (open.length === 0) return { error: `no ${wanted.paneTypeId} pane is open` }
      for (const leaf of open) layout.closeLeaf(leaf.id)
      return { closed: open.map((leaf) => leaf.id) }
    }
    if (wanted.inPaneType !== null) {
      const target = layout.leafSummary().find((leaf) => leaf.paneTypeId === wanted.inPaneType)
      if (!target) return { error: `no ${wanted.inPaneType} pane is open to swap into` }
      layout.setLeafType(target.id, wanted.paneTypeId)
      return { swapped: target.id }
    }
    if (wanted.split !== null) {
      layout.splitFocused(wanted.split, wanted.paneTypeId)
      return { split: wanted.split }
    }
    layout.ensurePane(wanted.paneTypeId)
    return { opened: wanted.paneTypeId }
  }, options)

  if ('error' in outcome) {
    let message = String(outcome.error)
    if ('available' in outcome)
      message += `\navailable: ${(outcome.available as string[]).join(' ')}`
    throw new Error(message)
  }
  // The pane mounts, and only then does focus move to it — a frame later at the
  // earliest, and a canvas pane takes a few.
  await page.waitForTimeout(500)
  return outcome
}

// -------------------------------------------------------------------- checks

/** The element lies wholly inside the window: nothing runs off an edge. */
export async function insideWindow(page: Page, target: Locator): Promise<CheckResult> {
  const box = await requireBox(target)
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const overflow: string[] = []
  if (box.x < 0) overflow.push(`left by ${round(-box.x)}px`)
  if (box.y < 0) overflow.push(`top by ${round(-box.y)}px`)
  if (box.x + box.width > size.width + 0.5) {
    overflow.push(`right by ${round(box.x + box.width - size.width)}px`)
  }
  if (box.y + box.height > size.height + 0.5) {
    overflow.push(`bottom by ${round(box.y + box.height - size.height)}px`)
  }
  if (overflow.length === 0) return pass(`inside the ${size.width}x${size.height} window`)
  return fail(`runs off the ${size.width}x${size.height} window: ${overflow.join(', ')}`)
}

/** The two elements do not cover each other. */
export async function notOverlapping(target: Locator, other: Locator): Promise<CheckResult> {
  const first = await requireBox(target)
  const second = await requireBox(other)
  const width =
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
  const height =
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
  // Touching edges, and the sub-pixel overlap rounding produces, are not overlap.
  if (width <= 1 || height <= 1) return pass('no overlap')
  return fail(`overlap of ${round(width)}x${round(height)}px`)
}

/**
 * Nothing of the element is cut off: its content fits it, and no ancestor that
 * hides overflow cuts into it.
 */
export async function notClipped(target: Locator): Promise<CheckResult> {
  await requireBox(target)
  const clipping = await target.evaluate((element) => {
    const found: string[] = []
    if (element.scrollWidth > element.clientWidth + 1) {
      found.push(`its content is ${element.scrollWidth - element.clientWidth}px wider than it`)
    }
    if (element.scrollHeight > element.clientHeight + 1) {
      found.push(`its content is ${element.scrollHeight - element.clientHeight}px taller than it`)
    }
    const own = element.getBoundingClientRect()
    let ancestor = element.parentElement
    while (ancestor !== null) {
      const style = getComputedStyle(ancestor)
      const hides = style.overflowX !== 'visible' || style.overflowY !== 'visible'
      const bounds = ancestor.getBoundingClientRect()
      const cut =
        own.left < bounds.left - 0.5 ||
        own.top < bounds.top - 0.5 ||
        own.right > bounds.right + 0.5 ||
        own.bottom > bounds.bottom + 0.5
      if (hides && cut) {
        found.push(
          `<${ancestor.tagName.toLowerCase()}> with overflow ${style.overflow} cuts it off`
        )
        break
      }
      ancestor = ancestor.parentElement
    }
    return found
  })
  if (clipping.length === 0) return pass('not clipped')
  return fail(clipping.join('; '))
}

/** The element is on screen. */
export async function visible(target: Locator): Promise<CheckResult> {
  if (await target.isVisible()) return pass(`${target} is visible`)
  return fail(`${target} is not visible`)
}

/** The element is not on screen. */
export async function gone(target: Locator): Promise<CheckResult> {
  if (await target.isVisible()) return fail(`${target} is still visible`)
  return pass(`${target} is gone`)
}

/** An expression in the renderer comes out as the value expected, compared as JSON. */
export async function evaluates(
  page: Page,
  expression: string,
  expected: unknown
): Promise<CheckResult> {
  const actual = await evaluate(page, expression)
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson === expectedJson) return pass(`${expression} is ${actualJson}`)
  return fail(`${expression} is ${actualJson}, expected ${expectedJson}`)
}

/** The renderer has logged no error — since `sinceMs` when given, since capture began otherwise. */
export async function noErrors(page: Page, sinceMs?: number): Promise<CheckResult> {
  const errors = await page.evaluate((since) => {
    const logged = (window as never as QaWindow).__qa_console ?? []
    return logged
      .filter((entry) => entry.level === 'error')
      .filter((entry) => since === null || entry.atMs >= since)
      .map((entry) => entry.text)
  }, sinceMs ?? null)
  if (errors.length === 0) return pass('no errors')
  return fail(`${errors.length} error(s): ${errors.slice(-3).join(' | ')}`)
}

/**
 * One expression in the renderer, awaited, as JSON on the way out — Svelte's
 * `$state` values are Proxies and do not survive structured cloning.
 */
export async function evaluate(page: Page, expression: string): Promise<unknown> {
  const json = await page.evaluate<string | null>(
    `Promise.resolve((() => (${expression}))()).then((value) => JSON.stringify(value === undefined ? null : value))`
  )
  if (json === null || json === undefined) return null
  return JSON.parse(json)
}

// ------------------------------------------------------------------- helpers

async function requireBox(target: Locator): Promise<Box> {
  const box = await target.boundingBox({ timeout: 10_000 })
  if (!box) throw new Error(`${target} is not on screen`)
  return box
}

function isLocator(target: Locator | Point): target is Locator {
  return typeof (target as Locator).boundingBox === 'function'
}

function round(value: number): number {
  return Math.round(value)
}

function pass(detail: string): CheckResult {
  return { passed: true, detail }
}

function fail(detail: string): CheckResult {
  return { passed: false, detail }
}

// The shapes reached for on `window`. Only what is used is declared; the
// renderer's own globals are typed for its build, not this one.
export interface QaConsoleEntry {
  level: string
  at: string
  atMs: number
  text: string
}

export interface QaWindow {
  __qa_console?: QaConsoleEntry[]
  __qa_record?: (level: string, text: string) => void
}

interface GroveWindow {
  __grove_debug?: {
    layout?: {
      leafSummary(): Array<{ id: string; paneTypeId: string }>
      ensurePane(paneTypeId: string): void
      splitFocused(direction: 'row' | 'column', paneTypeId?: string): void
      setLeafType(leafId: string, paneTypeId: string): void
      closeLeaf(leafId: string): void
    }
    panes?: { types: Array<{ id: string }>; get(id: string): unknown }
  }
}
