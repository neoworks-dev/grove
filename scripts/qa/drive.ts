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
import type { Browser, CDPSession, Locator, Page } from '@playwright/test'
import { parseTarget, describeTarget, NAME_ROLES, type Target } from './targets.ts'
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
  await page.screenshot({ path: command.screenshot })
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
 * Keep the renderer's console in a ring buffer on `window`.
 *
 * Playwright's own `page.on('console')` only reports what is logged while a
 * connection is open, and this driver connects for one action at a time. A
 * buffer in the page outlives the connection, which is what makes "what did it
 * complain about while I was not looking" answerable at all.
 */
async function installConsoleCapture(page: Page): Promise<void> {
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
  const paneTypeId = String(command.paneTypeId)
  const request = {
    paneTypeId,
    close: command.close === true,
    split: typeof command.split === 'string' ? command.split : null,
    inLeaf: typeof command.inLeaf === 'string' ? command.inLeaf : null
  }

  const outcome = await page.evaluate((options) => {
    const debug = (window as never as GroveWindow).__grove_debug
    const layout = debug?.layout
    const panes = debug?.panes
    if (!layout || !panes) return { error: 'renderer debug hooks missing — was GROVE_DEBUG set?' }
    if (!panes.get(options.paneTypeId)) {
      return {
        error: `no such pane type: ${options.paneTypeId}`,
        available: panes.types.map((type) => type.id).sort()
      }
    }

    if (options.close) {
      const open = layout.leafSummary().filter((leaf) => leaf.paneTypeId === options.paneTypeId)
      if (open.length === 0) return { error: `no ${options.paneTypeId} pane is open` }
      for (const leaf of open) layout.closeLeaf(leaf.id)
      return { closed: open.map((leaf) => leaf.id) }
    }
    if (options.inLeaf !== null) {
      const target = layout.leafSummary().find((leaf) => leaf.id === options.inLeaf)
      if (!target) return { error: `no such pane: ${options.inLeaf}` }
      layout.setLeafType(options.inLeaf, options.paneTypeId)
      return { swapped: options.inLeaf }
    }
    if (options.split !== null) {
      layout.splitFocused(options.split as 'row' | 'column', options.paneTypeId)
      return { split: options.split }
    }
    layout.ensurePane(options.paneTypeId)
    return { opened: options.paneTypeId }
  }, request)

  if ('error' in outcome) return outcome
  // The pane mounts, and only then does focus move to it — a frame later at the
  // earliest, and a canvas pane takes a few. Wait long enough that the tree
  // printed below is honest about which pane ended up focused.
  await page.waitForTimeout(500)
  return { ...outcome, ...(await snapshot(page, refsPath)) }
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
  return {
    dragged: `${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)}`
  }
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
  atMs: number
  text: string
}

interface QaWindow {
  __qa_console?: QaConsoleEntry[]
  __qa_record?: (level: string, text: string) => void
}

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
