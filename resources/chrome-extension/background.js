// Grove's browser extension: hands a tab to a worktree's agents, which drive
// it over the DevTools protocol through Grove. This wires the browser's events
// to the link (grove.js) and the served tabs (tabs.js), and keeps the badge,
// the context menu and the popup in step with them. Listeners are registered
// at the top level, as a service worker's must be.

import { GroveConnection } from './grove.js'
import { TabService } from './tabs.js'

// Grove's green, as Kit uses it.
const GROVE_GREEN = '#4ade80'
const BADGE_TEXT = '●'
const MENU_HAND_OVER = 'hand-over'
const MENU_HAND_OVER_PREFIX = 'hand-over:'
const MENU_TAKE_BACK = 'take-back'
const MENU_STATUS = 'status'
const MENU_CONTEXTS = ['page', 'action']

const grove = new GroveConnection({ onStatus: statusChanged, onRequest: answerGrove })
const tabs = new TabService(grove, { onChange: scheduleRefresh })

// Refreshes run one after another; removing and recreating the menu must not interleave.
let refreshQueue = Promise.resolve()
let refreshQueued = false

// ── Grove ─────────────────────────────────────────────────────────

/** The link changed state: on connecting, re-provide what was served and list the worktrees. */
function statusChanged(status) {
  if (status.state === 'connected') void tabs.provideAll()
  scheduleRefresh()
}

/** Grove's requests down the link. */
async function answerGrove(method, params) {
  if (method === 'browser.cdp') return tabs.cdp(params)
  if (method === 'browser.open') return tabs.open(params)
  throw Object.assign(new Error(`'${method}' wasn't found`), { code: -32601 })
}

// ── Browser events ────────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => tabs.debuggerEvent(source, method, params))
chrome.debugger.onDetach.addListener((source, reason) => void tabs.debuggerDetached(source, reason))
chrome.tabs.onRemoved.addListener((tabId) => void tabs.tabRemoved(tabId))
chrome.tabs.onUpdated.addListener((tabId, change, tab) => void tabs.tabUpdated(tabId, change, tab))
chrome.tabs.onReplaced.addListener((added, removed) => void tabs.tabReplaced(added, removed))
chrome.tabs.onActivated.addListener(() => scheduleRefresh())
chrome.contextMenus.onClicked.addListener((info, tab) => void menuClicked(info, tab))
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  popupAsked(message).then(reply, (error) => reply({ error: error.message }))
  return true
})

// ── The popup ─────────────────────────────────────────────────────

/** Answers the popup: its state, or an action it took. */
async function popupAsked(message) {
  if (message.type === 'hand-over') await tabs.handOver(message.tabId, message.worktreeId)
  if (message.type === 'take-back') await tabs.takeBack(message.tabId)
  if (message.type === 'pair') grove.pair()
  // Once per popup opening: the worktree list may have changed in Grove.
  if (message.type === 'opened' && grove.connected) await tabs.loadWorktrees().catch(() => {})
  return popupState(message.tabId)
}

/** Everything the popup shows for a tab. */
async function popupState(tabId) {
  let tab = null
  if (tabId !== undefined) tab = await chrome.tabs.get(tabId).catch(() => null)
  return {
    status: grove.status,
    worktrees: tabs.worktrees,
    tab: tabId,
    tabUrl: tab && tab.url,
    serving: tabs.describeTab(tabId),
    served: tabs.describeServed()
  }
}

// ── Badge and menu ────────────────────────────────────────────────

/** Refreshes badge, menu and popup once per burst of changes. */
function scheduleRefresh() {
  if (refreshQueued) return
  refreshQueued = true
  refreshQueue = refreshQueue
    .then(() => new Promise((resolve) => setTimeout(resolve, 50)))
    .then(() => {
      refreshQueued = false
      return refresh()
    })
    .catch((error) => console.warn('grove: refresh failed', error))
}

/** Brings the badges, the context menu and an open popup up to date. */
async function refresh() {
  await refreshBadges()
  await refreshMenu()
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {})
}

/** A green badge on every served tab, and none on the rest. */
async function refreshBadges() {
  const all = await chrome.tabs.query({})
  for (const tab of all) {
    const serving = tabs.describeTab(tab.id)
    if (!serving) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' })
      await chrome.action.setTitle({ tabId: tab.id, title: 'Grove' })
      continue
    }
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: GROVE_GREEN })
    await chrome.action.setBadgeText({ tabId: tab.id, text: BADGE_TEXT })
    await chrome.action.setTitle({ tabId: tab.id, title: `Grove — serving ${serving.worktreeName}` })
  }
}

/** "Hand to Grove ▸ worktree" and "Take back", rebuilt for the active tab. */
async function refreshMenu() {
  await chrome.contextMenus.removeAll()
  if (!grove.connected) {
    chrome.contextMenus.create({ id: MENU_STATUS, title: 'Grove isn’t connected', enabled: false, contexts: MENU_CONTEXTS })
    return
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (active && tabs.worktreeOf(active.id)) {
    chrome.contextMenus.create({ id: MENU_TAKE_BACK, title: 'Take back from Grove', contexts: MENU_CONTEXTS })
  }
  chrome.contextMenus.create({ id: MENU_HAND_OVER, title: 'Hand to Grove', contexts: MENU_CONTEXTS })
  for (const worktree of tabs.worktrees) {
    chrome.contextMenus.create({
      id: `${MENU_HAND_OVER_PREFIX}${worktree.id}`,
      parentId: MENU_HAND_OVER,
      title: `${worktree.name} (${worktree.branch})`,
      contexts: MENU_CONTEXTS
    })
  }
}

/** A context-menu choice. */
async function menuClicked(info, tab) {
  if (!tab) return
  const menuItemId = String(info.menuItemId)
  if (menuItemId === MENU_TAKE_BACK) {
    await tabs.takeBack(tab.id)
    return
  }
  if (!menuItemId.startsWith(MENU_HAND_OVER_PREFIX)) return
  await tabs.handOver(tab.id, menuItemId.slice(MENU_HAND_OVER_PREFIX.length)).catch((error) => console.warn(error))
}

// ── Start ─────────────────────────────────────────────────────────

void tabs.restore().then(() => grove.connect())
