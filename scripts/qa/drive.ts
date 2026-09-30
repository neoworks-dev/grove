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
// Every action also answers with the Playwright code that repeats it, under
// `recorded`, which `qa.ts` keeps as the session's recording. The element is
// named the way Playwright's own `normalize()` would name it — a role and a
// name, a test id — never the ref or the CSS path behind it, and the action is
// performed through that same locator, so a recording that ran live replays.
//
//   node scripts/qa/drive.ts <port> <refsPath> '<commandJson>'

import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import type { Browser, CDPSession, Locator, Page } from '@playwright/test'
import { parseTarget, describeTarget, NAME_ROLES, type Target } from './targets.ts'
import {
  drag as dragBetween,
  evaluate as evaluateExpression,
  gone,
  grabPoint,
  insideWindow,
  installConsoleCapture,
  noErrors,
  notClipped,
  notOverlapping,
  pane as openPane,
  scroll as scrollAt,
  visible,
  evaluates,
  type CheckResult,
  type Point,
  type QaWindow
} from './steps.ts'
import type {
  Box,
  LayoutSummary,
  PaneSummary,
  ProbeElement,
  RendererState,
  Snapshot,
  TreeNode
} from './snapshot.ts'

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
  // The pane this element is inside, from the nearest `[data-leaf]`. Null for
  // anything portalled out of the tree — a menu, a modal, the top bar.
  leaf: string | null
  // The gutter it belongs to instead, for the `+` that opens a pane in the gap.
  gutter: string | null
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
  // Before the action, not after: the errors worth catching are the ones this
  // action causes, and the drain only sees what happens while it is attached.
  await installConsoleCapture(page)
  const drain = await attachErrorDrain(page)

  const result = await perform(page, refsPath, command)
  if (typeof command.screenshot !== 'string') {
    await drain.detach().catch(() => undefined)
    return result
  }
  await page.screenshot({ path: command.screenshot, clip: cropOf(command) })
  await drain.detach().catch(() => undefined)
  return { ...(result as Record<string, unknown>), screenshot: command.screenshot }
}

async function perform(page: Page, refsPath: string, command: Command): Promise<unknown> {
  if (command.action === 'ready') {
    return ready(page, refsPath, Number(command.timeout ?? 60_000))
  }
  if (command.action === 'console') return consoleLog(page)
  if (command.action === 'probe') return probe(page, refsPath, command)
  if (command.action === 'panes') return paneTypes(page)
  if (command.action === 'pane') return pane(page, refsPath, command)
  if (command.action === 'shot') return shot(page, refsPath, command)
  if (command.action === 'click') return click(page, refsPath, command)
  if (command.action === 'drag') return drag(page, refsPath, command)
  if (command.action === 'type') return type(page, command)
  if (command.action === 'key') return key(page, command)
  if (command.action === 'scroll') return scroll(page, refsPath, command)
  if (command.action === 'wait') return wait(page, refsPath, command)
  if (command.action === 'eval') return evaluateExpression(page, String(command.expression))
  if (command.action === 'expect') return check(page, refsPath, command)
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
async function ready(page: Page, refsPath: string, timeout: number): Promise<unknown> {
  await page.waitForFunction(
    () => Boolean((window as never as GroveWindow).__grove_debug?.store?.selectedWorktree?.path),
    undefined,
    { timeout }
  )

  const notNow = page.getByRole('button', { name: 'Not now' })
  const dismissed = await notNow.isVisible().catch(() => false)
  if (dismissed) await notNow.click()

  return { ready: true, dismissedSetup: dismissed, ...(await snapshot(page, refsPath)) }
}

/** Everything the renderer has logged since the capture went in. */
async function consoleLog(page: Page): Promise<unknown> {
  await installConsoleCapture(page)
  return page.evaluate(() => (window as never as QaWindow).__qa_console ?? [])
}

/**
 * Report what the renderer never tells `console` about.
 *
 * A failed request, a blocked resource, a CSP violation and an uncaught throw
 * are all things Chromium knows and the page does not log. CDP reports them —
 * but only to a connected client, and this driver connects for one action at a
 * time. So they are pushed into the page's own ring buffer, where they outlive
 * the connection and the next `probe` can count them.
 */
async function attachErrorDrain(page: Page): Promise<{ detach: () => Promise<void> }> {
  const record = (level: string, text: string): void => {
    void page
      .evaluate((entry) => (window as never as QaWindow).__qa_record?.(entry.level, entry.text), {
        level,
        text
      })
      .catch(() => undefined)
  }

  let session: CDPSession
  try {
    session = await page.context().newCDPSession(page)
  } catch {
    // An older Electron, or a page that went away mid-connection: the console
    // patch above is still in place, so carry on without the extra reporting.
    return { detach: () => Promise.resolve() }
  }

  session.on('Log.entryAdded', (event) => {
    const entry = event.entry
    let level = 'warn'
    if (entry.level === 'error') level = 'error'
    record(level, `${entry.source}: ${entry.text}`)
  })
  session.on('Runtime.exceptionThrown', (event) => {
    const details = event.exceptionDetails
    let text = details.text
    if (details.exception?.description) text = details.exception.description
    record('error', text)
  })
  await session.send('Log.enable').catch(() => undefined)
  await session.send('Runtime.enable').catch(() => undefined)

  return { detach: () => session.detach() }
}

// ------------------------------------------------------------------- probing

/**
 * What is on screen, as the pane tree it actually is.
 *
 * A flat list of buttons says nothing about where they are: an agent reading one
 * cannot tell whether the GitHub pane is open, and goes looking for it with
 * screenshots. So the panes come from the layout store, every element hangs off
 * the pane that contains it, and anything portalled out of the tree — a menu, a
 * modal, the top bar — is collected separately.
 *
 * Refs are written to disk so the next invocation can resolve them, and they are
 * only valid until the screen changes under them: a stale one is an error, not a
 * click somewhere unintended.
 */
async function probe(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const taken = await snapshot(page, refsPath)
  if (typeof command.filter !== 'string') return taken
  return filterSnapshot(taken, command.filter)
}

/** The tree, the panes, the elements and the session's own state, in one pass. */
async function snapshot(page: Page, refsPath: string): Promise<Snapshot> {
  const [entries, state] = await Promise.all([
    page.evaluate<ProbeEntry[]>(probeScript),
    page.evaluate<RendererState>(stateScript)
  ])
  writeFileSync(refsPath, JSON.stringify(entries, null, 2), 'utf8')

  const byPane = new Map<string | null, ProbeElement[]>()
  const byGutter: Record<string, ProbeElement[]> = {}
  for (const entry of entries) {
    if (entry.gutter !== null) {
      const gutter = byGutter[entry.gutter] ?? []
      gutter.push(describeElement(entry))
      byGutter[entry.gutter] = gutter
      continue
    }
    const bucket = byPane.get(entry.leaf) ?? []
    bucket.push(describeElement(entry))
    byPane.set(entry.leaf, bucket)
  }

  return {
    ...state,
    tree: state.tree === null ? null : attachElements(state.tree, state.leafBoxes, byPane),
    gutterElements: byGutter,
    overlays: byPane.get(null) ?? []
  }
}

/** One element as a probe reader sees it: how to name it, and where it is. */
function describeElement(entry: ProbeEntry): ProbeElement {
  const grab = grabPoint(entry.box)
  const element: ProbeElement = {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    at: `${Math.round(grab.x)},${Math.round(grab.y)}`,
    size: `${Math.round(entry.box.width)}x${Math.round(entry.box.height)}`
  }
  if (entry.disabled) element.disabled = true
  return element
}

/** Hang each pane's elements and rendered size off its node in the tree. */
function attachElements(
  node: LayoutSummary,
  boxes: Record<string, Box>,
  byPane: Map<string | null, ProbeElement[]>
): TreeNode {
  if (node.kind === 'split') {
    return {
      ...node,
      children: node.children.map((child) => attachElements(child, boxes, byPane))
    }
  }
  const box = boxes[node.id]
  return {
    ...node,
    width: box ? Math.round(box.width) : 0,
    height: box ? Math.round(box.height) : 0,
    elements: byPane.get(node.id) ?? []
  }
}

/**
 * Keep only the elements a filter names, and say so.
 *
 * The panes stay: which of them holds the match is most of the answer, and a
 * pane that turns out to hold nothing matching is worth seeing too.
 */
function filterSnapshot(taken: Snapshot, filter: string): Snapshot {
  const needle = filter.toLowerCase()
  const matches = (element: ProbeElement): boolean =>
    element.name.toLowerCase().includes(needle) ||
    element.role.includes(needle) ||
    element.ref === needle

  const prune = (node: TreeNode): TreeNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(prune) }
    return { ...node, elements: node.elements.filter(matches) }
  }

  const gutterElements: Record<string, ProbeElement[]> = {}
  for (const [gutter, elements] of Object.entries(taken.gutterElements)) {
    gutterElements[gutter] = elements.filter(matches)
  }

  return {
    ...taken,
    filter,
    tree: taken.tree === null ? null : prune(taken.tree),
    gutterElements,
    overlays: taken.overlays.filter(matches)
  }
}

// ------------------------------------------------------------------ pane types

/**
 * Every pane type the kernel has registered, and whether one is open.
 *
 * Read off the registry rather than listed here: a plugin's panes appear the
 * moment it loads, and nothing goes stale.
 */
async function paneTypes(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const debug = (window as never as GroveWindow).__grove_debug
    if (!debug?.panes || !debug.layout) {
      return { error: 'renderer debug hooks missing — was GROVE_DEBUG set?' }
    }
    const open = debug.layout.leafSummary()
    return {
      types: debug.panes.types
        .map((type) => {
          const leaves = open.filter((leaf) => leaf.paneTypeId === type.id)
          const entry: Record<string, unknown> = { id: type.id, title: type.title }
          if (type.slot) entry.slot = type.slot
          if (type.preferredEdge) entry.edge = type.preferredEdge.side
          if (type.rail) entry.rail = true
          if (leaves.length > 0) entry.open = leaves.map((leaf) => leaf.id)
          if (type.when && !type.when()) entry.unavailable = true
          return entry
        })
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    }
  })
}

/**
 * Open, move or close a pane by type, the way a command would.
 *
 * The point is not to skip the UI but to stop paying for it: finding the gutter
 * that opens a GitHub pane takes an agent a dozen actions, and none of them are
 * what it was sent to test. The picker and the rail still need exercising — by
 * whoever is testing the picker and the rail.
 */
async function pane(page: Page, refsPath: string, command: Command): Promise<unknown> {
  let split: 'row' | 'column' | null = null
  if (command.split === 'row' || command.split === 'column') split = command.split
  let inPaneType: string | null = null
  if (typeof command.inLeaf === 'string') inPaneType = await paneTypeOf(page, command.inLeaf)
  const request = {
    paneTypeId: String(command.paneTypeId),
    close: command.close === true,
    split,
    inPaneType
  }

  // Waits for the pane to mount and take focus, so the tree printed below is
  // honest about which pane ended up focused.
  const outcome = await openPane(page, request)
  return {
    ...outcome,
    ...(await snapshot(page, refsPath)),
    recorded: [`await qa.pane(page, ${JSON.stringify(request)})`]
  }
}

/** The type of the pane a leaf id names, which is what a recording can find again. */
async function paneTypeOf(page: Page, leafId: string): Promise<string> {
  const paneTypeId = await page.evaluate((wanted) => {
    const layout = (window as never as GroveWindow).__grove_debug?.layout
    const leaf = layout?.leafSummary().find((candidate) => candidate.id === wanted)
    if (leaf === undefined) return null
    return leaf.paneTypeId
  }, leafId)
  if (paneTypeId === null) throw new Error(`no such pane: ${leafId} — run "qa probe" again`)
  return paneTypeId
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
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
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

    const role = roleOf(element)
    const gutter = element.closest('[data-gutter]')?.getAttribute('data-gutter') ?? null
    // A gutter is two nested separators, and the tree already names it by the id
    // it is targeted with. Reporting them as elements as well would put every
    // divider in the window twice.
    if (gutter !== null && role === 'separator') continue

    const entry: ProbeEntry = {
      ref: `e${next}`,
      role,
      name: nameOf(element),
      selector: selectorFor(element),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      leaf: element.closest('[data-leaf]')?.getAttribute('data-leaf') ?? null,
      gutter
    }
    if (element.hasAttribute('disabled')) entry.disabled = true
    entries.push(entry)
    next += 1
  }
  return entries
}

/**
 * The session's own account of itself: the pane tree, the worktree, the agents,
 * and what has gone wrong so far.
 *
 * Serialised into the renderer like `probeScript`, so it stands alone.
 */
const stateScript = (): RendererState => {
  const debug = (window as never as GroveWindow).__grove_debug
  const empty: RendererState = {
    window: { width: window.innerWidth, height: window.innerHeight },
    view: null,
    worktree: null,
    activeTab: null,
    activePane: null,
    activeLeafId: null,
    tree: null,
    leafBoxes: {},
    gutters: [],
    agentSessions: [],
    reviewQueue: 0,
    errors: { count: 0, recent: [] }
  }
  if (!debug?.layout) {
    return { ...empty, error: 'renderer debug hooks missing — was GROVE_DEBUG set?' }
  }

  const leafBoxes: Record<string, Box> = {}
  for (const element of Array.from(document.querySelectorAll('[data-leaf]'))) {
    const id = element.getAttribute('data-leaf')
    if (id === null) continue
    const box = element.getBoundingClientRect()
    leafBoxes[id] = { x: box.x, y: box.y, width: box.width, height: box.height }
  }

  const logged = (window as never as QaWindow).__qa_console ?? []
  const errors = logged.filter((entry) => entry.level === 'error')
  const viewId = debug.layout.activeViewId
  const view = debug.views?.get(viewId) ?? null

  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    view: { id: viewId, label: view === null ? viewId : view.label },
    worktree: debug.store?.selectedWorktree?.path ?? null,
    activeTab: debug.store?.activeTabPath ?? null,
    activePane: debug.keymap?.activePane ?? null,
    activeLeafId: debug.keymap?.activeLeafId ?? null,
    tree: debug.layout.treeSummary(),
    leafBoxes,
    // Only the gutters actually rendered: focus mode folds the tree down and
    // takes every gutter with it, so a tree node is not proof of a handle.
    gutters: Array.from(document.querySelectorAll('[data-gutter]'))
      .map((element) => element.getAttribute('data-gutter'))
      .filter((id): id is string => id !== null),
    agentSessions: (debug.agentSessions?.list ?? []).map((session) => ({
      id: session.id,
      status: session.status
    })),
    reviewQueue: (debug.review?.queue ?? []).length,
    storeError: debug.store?.error,
    bootError: (window as never as GroveWindow).__grove_boot_error,
    focusMode: debug.layout.focusMode,
    errors: { count: errors.length, recent: errors.slice(-5).map((entry) => entry.text) }
  }
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
  if (target.kind === 'leaf') return page.locator(`[data-leaf="${target.leafId}"]`)
  if (target.kind === 'gutter') {
    return page.locator(`[data-gutter="${target.splitId}:${target.index}"]`)
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

/**
 * A target, resolved to what the action runs against and the code that finds it
 * again: a locator for an element, or a point for `at=x,y`.
 */
interface Resolved {
  locator: Locator | null
  point: Point | null
  code: string
}

/**
 * Resolve a target the way a recording can repeat it.
 *
 * An element is renamed through `normalize()` — Playwright's own choice of a
 * role and name or a test id — and the action then runs through that renamed
 * locator. A ref or a CSS path means nothing on a fresh profile; and acting
 * through the recorded locator rather than beside it means a locator that
 * matches the wrong thing fails here, where it can be seen, and not on replay.
 *
 * `wait` asks for an element that may not exist yet, which there is nothing to
 * normalize from; it is recorded as written.
 */
async function resolve(
  page: Page,
  refsPath: string,
  input: string,
  options: { normalize: boolean } = { normalize: true }
): Promise<Resolved> {
  const target = parseTarget(input)
  if (target.kind === 'point') {
    return { locator: null, point: { x: target.x, y: target.y }, code: pointCode(target) }
  }
  const written = locate(page, refsPath, target)
  if (!options.normalize) return { locator: written, point: null, code: `page.${written}` }

  const normalized = await written.normalize().catch(() => written)
  return { locator: normalized, point: null, code: `page.${normalized}` }
}

/** A resolved target as an argument to a `qa.*` helper: the locator, or the point. */
function targetOf(resolved: Resolved): Locator | Point {
  if (resolved.locator !== null) return resolved.locator
  return resolved.point as Point
}

function pointCode(point: Point): string {
  return `{ x: ${point.x}, y: ${point.y} }`
}

/** A string as a literal in the recorded code. */
function literal(value: string): string {
  return JSON.stringify(value)
}

// ------------------------------------------------------------------- actions

async function click(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const button = (command.button as 'left' | 'right' | 'middle') ?? 'left'
  const clickCount = Number(command.count ?? 1)
  const resolved = await resolve(page, refsPath, String(command.target))

  if (resolved.point !== null) {
    await page.mouse.click(resolved.point.x, resolved.point.y, { button, clickCount })
    return {
      clicked: pointCode(resolved.point),
      recorded: [
        `await page.mouse.click(${resolved.point.x}, ${resolved.point.y}${clickOptions(button, clickCount)})`
      ]
    }
  }
  const locator = resolved.locator as Locator
  await locator.click({ button, clickCount, timeout: 15_000 })
  let method = 'click'
  if (clickCount === 2 && button === 'left') method = 'dblclick'
  let options = clickOptions(button, clickCount)
  if (method === 'dblclick') options = ''
  return {
    clicked: resolved.code,
    recorded: [`await ${resolved.code}.${method}(${options.replace(/^, /, '')})`]
  }
}

/** The options object a recorded click needs, with a leading comma, or nothing. */
function clickOptions(button: string, clickCount: number): string {
  const parts: string[] = []
  if (button !== 'left') parts.push(`button: '${button}'`)
  if (clickCount !== 1) parts.push(`clickCount: ${clickCount}`)
  if (parts.length === 0) return ''
  return `, { ${parts.join(', ')} }`
}

/** Press, move, release — the way a person resizes a pane. See `steps.drag`. */
async function drag(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const from = await resolve(page, refsPath, String(command.from))
  const to = await resolve(page, refsPath, String(command.to))
  const moved = await dragBetween(page, targetOf(from), targetOf(to))
  return {
    dragged: `${Math.round(moved.from.x)},${Math.round(moved.from.y)} → ${Math.round(moved.to.x)},${Math.round(moved.to.y)}`,
    recorded: [`await qa.drag(page, ${from.code}, ${to.code})`]
  }
}

/** Type into whatever has focus, a keystroke at a time. */
async function type(page: Page, command: Command): Promise<unknown> {
  const text = String(command.text)
  await page.keyboard.type(text, { delay: 20 })
  return {
    typed: text.length,
    recorded: [`await page.keyboard.type(${literal(text)}, { delay: 20 })`]
  }
}

/** Press keys or chords in order: `Escape`, `Control+s`, `g g`. */
async function key(page: Page, command: Command): Promise<unknown> {
  const keys = Array.isArray(command.keys) ? (command.keys as string[]) : [String(command.keys)]
  const recorded: string[] = []
  for (const chord of keys) {
    await page.keyboard.press(chord, { delay: 20 })
    recorded.push(`await page.keyboard.press(${literal(chord)}, { delay: 20 })`)
  }
  return { pressed: keys, recorded }
}

async function scroll(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const deltaY = Number(command.dy ?? 0)
  let over: Resolved | null = null
  if (command.target !== undefined) over = await resolve(page, refsPath, String(command.target))

  if (over === null) {
    await scrollAt(page, null, deltaY)
    return { scrolled: { deltaY }, recorded: [`await qa.scroll(page, null, ${deltaY})`] }
  }
  await scrollAt(page, targetOf(over), deltaY)
  return { scrolled: { deltaY }, recorded: [`await qa.scroll(page, ${over.code}, ${deltaY})`] }
}

/** Wait for a target to appear, or to go away. */
async function wait(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const gone = command.gone === true
  const timeout = Number(command.timeout ?? 20_000)
  const resolved = await resolve(page, refsPath, String(command.target), { normalize: false })
  if (resolved.locator === null) throw new Error('wait needs an element, not a point')

  let state: 'visible' | 'hidden' = 'visible'
  if (gone) state = 'hidden'
  await resolved.locator.waitFor({ state, timeout })
  return {
    [state]: resolved.code,
    recorded: [`await ${resolved.code}.waitFor({ state: '${state}', timeout: ${timeout} })`]
  }
}

/**
 * Check what should be true of the app, the way a repro checks it.
 *
 * Answers whether it held rather than failing the command: in a live session a
 * check that fails is the finding, not an error. The recorded line is what the
 * repro spec runs, where a failure does fail the test.
 */
async function check(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const kind = String(command.check)
  const label = String(command.label)
  const { result, call } = await runCheck(page, refsPath, kind, command)
  return {
    passed: result.passed,
    detail: result.detail,
    label,
    recorded: [`await verify(page, ${literal(label)}, ${call})`]
  }
}

/** One check, and the `qa.*` call that repeats it. */
async function runCheck(
  page: Page,
  refsPath: string,
  kind: string,
  command: Command
): Promise<{ result: CheckResult; call: string }> {
  if (kind === 'no-errors') {
    return { result: await noErrors(page, Number(command.sinceMs)), call: 'qa.noErrors(page)' }
  }
  if (kind === 'eval') {
    const expression = String(command.expression)
    const expected = command.expected
    return {
      result: await evaluates(page, expression, expected),
      call: `qa.evaluates(page, ${literal(expression)}, ${JSON.stringify(expected)})`
    }
  }
  // Every other check is about an element that has to exist to be measured —
  // except `gone`, whose element may well not, and which is recorded as written.
  const subject = await resolve(page, refsPath, String(command.target), {
    normalize: kind !== 'gone'
  })
  if (subject.locator === null) throw new Error(`${kind} needs an element, not a point`)
  const locator = subject.locator

  if (kind === 'visible')
    return { result: await visible(locator), call: `qa.visible(${subject.code})` }
  if (kind === 'gone') return { result: await gone(locator), call: `qa.gone(${subject.code})` }
  if (kind === 'inside-window') {
    return {
      result: await insideWindow(page, locator),
      call: `qa.insideWindow(page, ${subject.code})`
    }
  }
  if (kind === 'not-clipped') {
    return { result: await notClipped(locator), call: `qa.notClipped(${subject.code})` }
  }
  if (kind === 'not-overlapping') {
    const other = await resolve(page, refsPath, String(command.other))
    if (other.locator === null) throw new Error('not-overlapping needs two elements')
    return {
      result: await notOverlapping(locator, other.locator),
      call: `qa.notOverlapping(${subject.code}, ${other.code})`
    }
  }
  throw new Error(`unknown check: ${kind}`)
}

async function shot(page: Page, refsPath: string, command: Command): Promise<unknown> {
  const path = String(command.path)
  if (command.target !== undefined) {
    const locator = locate(page, refsPath, parseTarget(String(command.target)))
    await locator.screenshot({ path })
    return { shot: path, of: String(command.target) }
  }
  const crop = cropOf(command)
  await page.screenshot({ path, clip: crop })
  if (crop) return { shot: path, crop: `${crop.x},${crop.y},${crop.width},${crop.height}` }
  return { shot: path }
}

/**
 * The rectangle a command asked to be photographed, if it asked for one.
 *
 * Already validated on the way in — this only has to put it in the shape
 * Playwright clips with.
 */
function cropOf(command: Command): Box | undefined {
  const crop = command.crop as Box | undefined
  if (!crop) return undefined
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
}

// The shapes this driver reaches for on `window`. Only what is used is
// declared; the renderer's own globals are typed for its build, not this one.

interface DebugPaneType {
  id: string
  title: string
  slot?: string
  rail?: { order: number }
  preferredEdge?: { side: string }
  when?: () => boolean
}

interface GroveWindow {
  __grove_boot_error?: string
  __grove_debug?: {
    store?: { selectedWorktree?: { path: string }; activeTabPath?: string; error?: string }
    keymap?: { activePane?: string; activeLeafId?: string }
    layout?: {
      activeViewId: string
      focusMode: boolean
      leafSummary(): PaneSummary[]
      treeSummary(): LayoutSummary
      ensurePane(paneTypeId: string): void
      splitFocused(direction: 'row' | 'column', paneTypeId?: string): void
      setLeafType(leafId: string, paneTypeId: string): void
      closeLeaf(leafId: string): void
    }
    panes?: { types: DebugPaneType[]; get(id: string): DebugPaneType | null }
    views?: { get(id: string): { id: string; label: string } | null }
    review?: { queue?: unknown[] }
    agentSessions?: { list?: Array<{ id: string; status: string }> }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message.split('\n').slice(0, 6).join('\n'))
  process.exit(1)
})
