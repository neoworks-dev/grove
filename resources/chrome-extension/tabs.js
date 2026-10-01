// The tabs handed to Grove: one per worktree, each driven through
// chrome.debugger. The debugger attaches on the first command rather than on
// hand-over, because Chrome shows its "started debugging this browser" bar for
// as long as it is attached, and detaches when the tab is taken back.

import {
  EVENT_DOMAINS,
  FORWARDED_EVENTS,
  VIEWPORT_EXPRESSION,
  cdpError,
  cssPixelScreenshotParams,
  describeCommand,
  isDrivableUrl,
  parseCdpError,
  slimEvent
} from './cdp.js'

const PROTOCOL_VERSION = '1.3'
// Most recent agent actions kept per tab, for the popup.
const ACTIVITY_LIMIT = 6
const STORAGE_KEY = 'served'

export class TabService {
  /** `onChange()` runs whenever what is served, or what the agent did, changed. */
  constructor(grove, { onChange }) {
    this.grove = grove
    this.onChange = onChange
    // worktreeId → { tabId, worktreeName, attached, attaching, activity }
    this.served = new Map()
    this.worktrees = []
  }

  // ── What is served ──────────────────────────────────────────────

  /** Restores what was served before the service worker restarted. */
  async restore() {
    const stored = await chrome.storage.session.get(STORAGE_KEY)
    const entries = stored[STORAGE_KEY] || []
    for (const [worktreeId, saved] of entries) {
      this.served.set(worktreeId, newEntry(saved.tabId, saved.worktreeName))
    }
    this.onChange()
  }

  /** The worktree a tab serves, or null. */
  worktreeOf(tabId) {
    for (const [worktreeId, entry] of this.served) {
      if (entry.tabId === tabId) return worktreeId
    }
    return null
  }

  /** Grove's worktrees, fetched again. Empty while Grove isn't connected. */
  async loadWorktrees() {
    if (!this.grove.connected) return this.worktrees
    const worktrees = await this.grove.request('browser.worktrees', {})
    if (JSON.stringify(worktrees) === JSON.stringify(this.worktrees)) return this.worktrees
    this.worktrees = worktrees
    this.onChange()
    return this.worktrees
  }

  /** Hands a tab to a worktree's agents; whatever either served before stops. */
  async handOver(tabId, worktreeId) {
    const tab = await chrome.tabs.get(tabId)
    if (!isDrivableUrl(tab.url)) throw new Error('Chrome doesn’t let extensions drive this page.')
    const previous = this.worktreeOf(tabId)
    if (previous && previous !== worktreeId) await this.takeBack(tabId)
    await this.grove.request('browser.provide', { worktreeId, tab: tabSummary(tab) })
    const existing = this.served.get(worktreeId)
    if (existing && existing.tabId === tabId) {
      await this.changed()
      return
    }
    await this.release(existing)
    this.served.set(worktreeId, newEntry(tabId, this.worktreeName(worktreeId)))
    await this.changed()
  }

  /** Takes a tab back from Grove: withdraws it and detaches the debugger. */
  async takeBack(tabId) {
    const worktreeId = this.worktreeOf(tabId)
    if (!worktreeId) return
    const entry = this.served.get(worktreeId)
    this.served.delete(worktreeId)
    if (this.grove.connected) await this.grove.request('browser.withdraw', { worktreeId }).catch(() => {})
    await this.release(entry)
    await this.changed()
  }

  /** Provides every served tab again, after Grove came (back) up; drops the ones it refuses. */
  async provideAll() {
    await this.loadWorktrees().catch(() => {})
    for (const [worktreeId, entry] of [...this.served]) {
      const tab = await chrome.tabs.get(entry.tabId).catch(() => null)
      const provided = tab && (await this.provide(worktreeId, tab))
      if (provided) continue
      this.served.delete(worktreeId)
      await this.release(entry)
    }
    await this.changed()
  }

  /** Tells Grove where a served tab is now; false when Grove refused it. */
  async provide(worktreeId, tab) {
    try {
      await this.grove.request('browser.provide', { worktreeId, tab: tabSummary(tab) })
      return true
    } catch {
      return false
    }
  }

  // ── Grove's requests ────────────────────────────────────────────

  /** `browser.cdp`: one DevTools command for the worktree's tab, attaching on the first. */
  async cdp({ worktreeId, method, params }) {
    const entry = this.served.get(worktreeId)
    if (!entry) throw cdpError(-32000, 'No tab serves this worktree.')
    this.recordActivity(entry, method, params)
    await this.ensureAttached(entry)
    const target = { tabId: entry.tabId }
    let commandParams = params || {}
    if (method === 'Page.captureScreenshot') {
      const viewport = await evaluateValue(target, VIEWPORT_EXPRESSION)
      commandParams = cssPixelScreenshotParams(commandParams, viewport)
    }
    return sendCommand(target, method, commandParams)
  }

  /** `browser.open`: a new tab for the worktree, in a tab group named after it, handed over. */
  async open({ worktreeId, url }) {
    if (!this.worktreeName(worktreeId, null)) await this.loadWorktrees()
    const name = this.worktreeName(worktreeId)
    let address = 'about:blank'
    if (url) address = url
    const tab = await createTab(address)
    await groupInto(tab, name)
    await this.handOver(tab.id, worktreeId)
    return null
  }

  // ── Browser events ──────────────────────────────────────────────

  /** A debugger event from a served tab: sent up when Grove reads it. */
  debuggerEvent(source, method, params) {
    if (!FORWARDED_EVENTS.has(method)) return
    const worktreeId = this.worktreeOf(source.tabId)
    if (!worktreeId) return
    this.grove.event('browser.cdpEvent', { worktreeId, method, params: slimEvent(method, params) })
  }

  /** The debugger let go: the user cancelled Chrome's bar, which takes the tab back. */
  async debuggerDetached(source, reason) {
    const worktreeId = this.worktreeOf(source.tabId)
    if (!worktreeId) return
    this.served.get(worktreeId).attached = false
    if (reason === 'canceled_by_user') await this.takeBack(source.tabId)
  }

  /** A served tab closed. */
  async tabRemoved(tabId) {
    await this.takeBack(tabId)
  }

  /** A served tab moved or was retitled: Grove hears where it is now. */
  async tabUpdated(tabId, change, tab) {
    if (change.url === undefined && change.title === undefined) return
    const worktreeId = this.worktreeOf(tabId)
    if (!worktreeId || !this.grove.connected) return
    await this.provide(worktreeId, tab)
  }

  /** Chrome swapped a tab for another (prerendering, discarding): follow it. */
  async tabReplaced(addedTabId, removedTabId) {
    const worktreeId = this.worktreeOf(removedTabId)
    if (!worktreeId) return
    const entry = this.served.get(worktreeId)
    entry.tabId = addedTabId
    entry.attached = false
    await this.changed()
  }

  // ── For the popup ───────────────────────────────────────────────

  /** What the popup shows about a tab: what it serves, and what the agent did there. */
  describeTab(tabId) {
    const worktreeId = this.worktreeOf(tabId)
    if (!worktreeId) return null
    const entry = this.served.get(worktreeId)
    return { worktreeId, worktreeName: entry.worktreeName, attached: entry.attached, activity: entry.activity }
  }

  /** Every served tab, for the popup's list. */
  describeServed() {
    return [...this.served].map(([worktreeId, entry]) => ({ worktreeId, worktreeName: entry.worktreeName, tabId: entry.tabId }))
  }

  // ── Plumbing ────────────────────────────────────────────────────

  /** A worktree's name from Grove's list; the fallback, or its last path segment, when unknown. */
  worktreeName(worktreeId, fallback) {
    const worktree = this.worktrees.find((candidate) => candidate.id === worktreeId)
    if (worktree) return worktree.name
    if (fallback !== undefined) return fallback
    return worktreeId.split('/').filter(Boolean).pop() || worktreeId
  }

  /** Attaches the debugger once, however many commands arrive while it does. */
  async ensureAttached(entry) {
    if (entry.attached) return
    if (!entry.attaching) {
      entry.attaching = attachDebugger(entry.tabId).finally(() => {
        entry.attaching = null
      })
    }
    await entry.attaching
    entry.attached = true
    this.onChange()
  }

  /** Notes what the agent did, when it changes the page. */
  recordActivity(entry, method, params) {
    const text = describeCommand(method, params)
    if (!text) return
    entry.activity.unshift({ text, at: Date.now() })
    entry.activity.length = Math.min(entry.activity.length, ACTIVITY_LIMIT)
    this.onChange()
  }

  /** Stops driving a tab: detaches the debugger. */
  async release(entry) {
    if (!entry) return
    await chrome.debugger.detach({ tabId: entry.tabId }).catch(() => {})
  }

  /** Saves what is served, and tells the listener. */
  async changed() {
    const entries = [...this.served].map(([worktreeId, entry]) => [worktreeId, { tabId: entry.tabId, worktreeName: entry.worktreeName }])
    await chrome.storage.session.set({ [STORAGE_KEY]: entries })
    this.onChange()
  }
}

/** A freshly served tab: not attached yet, nothing done. */
function newEntry(tabId, worktreeName) {
  return { tabId, worktreeName, attached: false, attaching: null, activity: [] }
}

/** A tab as `browser.provide` describes it. */
function tabSummary(tab) {
  let url = tab.url
  if (!url) url = tab.pendingUrl || ''
  return { url, title: tab.title || '' }
}

/** Attaches the debugger and turns on the domains whose events Grove reads. */
async function attachDebugger(tabId) {
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION)
  } catch (error) {
    // Still attached from before the service worker restarted.
    if (!String(error.message).includes('already attached')) throw cdpError(-32000, `Can’t drive this tab: ${error.message}`)
  }
  for (const domain of EVENT_DOMAINS) await sendCommand(target, `${domain}.enable`, {})
}

/** One DevTools command; Chrome's rejection becomes a CDP error. */
async function sendCommand(target, method, params) {
  try {
    return await chrome.debugger.sendCommand(target, method, params)
  } catch (error) {
    throw parseCdpError(error)
  }
}

/** Evaluates an expression in the tab and returns its value. */
async function evaluateValue(target, expression) {
  const reply = await sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true })
  return reply.result.value
}

/** A new active tab, in a new window when the browser has none open. */
async function createTab(url) {
  try {
    return await chrome.tabs.create({ url, active: true })
  } catch {
    const window = await chrome.windows.create({ url, focused: true })
    return window.tabs[0]
  }
}

/** Puts a tab into its window's group with this title, making the group when there is none. */
async function groupInto(tab, title) {
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title })
  if (groups.length > 0) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id })
    return
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } })
  await chrome.tabGroups.update(groupId, { title, color: 'green' })
}
