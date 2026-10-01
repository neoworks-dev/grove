// The toolbar popup: how the link to Grove is, and for the active tab either
// the worktrees to hand it to or the one it serves, with what the agent has
// been doing there. The service worker holds the state; this only renders it.

import { isDrivableUrl } from './cdp.js'

const content = document.getElementById('content')
const link = document.getElementById('link')

// What each link state says, when it isn't `connected`.
const STATES = {
  'host-missing': {
    label: 'Not connected',
    title: 'Grove isn’t connected to this browser',
    text: 'In Grove, open View ▸ Connect Chrome and connect this browser.'
  },
  'grove-down': {
    label: 'Not running',
    title: 'Grove isn’t running',
    text: 'Start Grove; this connects as soon as it is up.'
  },
  'needs-pairing': {
    label: 'Not paired',
    title: 'Pair with Grove',
    text: 'Grove asks you to approve this browser once.',
    action: 'Pair'
  },
  pairing: { label: 'Pairing', title: 'Approve in Grove', text: 'Grove is asking whether this browser may provide tabs.' },
  connecting: { label: 'Connecting', title: 'Connecting to Grove…', text: '' }
}

let activeTabId
let lastState = null
let lastError = ''

/** Sends the service worker a message and renders the state it answers with. */
async function ask(message) {
  const state = await chrome.runtime.sendMessage({ ...message, tabId: activeTabId })
  lastError = ''
  if (state && state.error) {
    lastError = state.error
    return ask({ type: 'state' })
  }
  lastState = state
  render(state)
  return state
}

/** Renders the whole popup from the service worker's state. */
function render(state) {
  renderLink(state.status)
  content.replaceChildren()
  if (state.status.state !== 'connected') {
    renderDisconnected(state.status)
    return
  }
  if (state.serving) renderServing(state.serving)
  if (!state.serving) renderHandOver(state)
  renderOthers(state)
  if (lastError) content.append(element('p', { className: 'error', text: lastError }))
}

/** The link's state in the header. */
function renderLink(status) {
  link.className = 'link'
  if (status.state === 'connected') {
    link.classList.add('connected')
    link.textContent = 'Connected'
    return
  }
  if (status.state === 'pairing' || status.state === 'connecting') link.classList.add('waiting')
  link.textContent = STATES[status.state].label
}

/** Why there is nothing to do yet, and what to do about it. */
function renderDisconnected(status) {
  const copy = STATES[status.state]
  content.append(element('h2', { text: copy.title }))
  if (copy.text) content.append(element('p', { text: copy.text }))
  if (status.detail) content.append(element('p', { className: 'detail', text: status.detail }))
  if (!copy.action) return
  const button = element('button', { className: 'primary', text: copy.action })
  button.addEventListener('click', () => void ask({ type: 'pair' }))
  content.append(button)
}

/** The worktree this tab serves, a way to take it back, and what the agent did. */
function renderServing(serving) {
  const row = element('div', { className: 'serving' })
  row.append(element('span', { className: 'dot' }))
  const label = element('span')
  label.append('Serving ', element('span', { className: 'name', text: serving.worktreeName }))
  row.append(label)
  const takeBack = element('button', { className: 'secondary', text: 'Take back' })
  takeBack.addEventListener('click', () => void ask({ type: 'take-back' }))
  row.append(takeBack)
  content.append(row)

  content.append(element('div', { className: 'caps', text: 'Agent activity' }))
  if (serving.activity.length === 0) {
    content.append(element('p', { className: 'detail', text: 'No agent has acted in this tab yet.' }))
    return
  }
  const list = element('ul', { className: 'activity' })
  for (const entry of serving.activity) {
    const item = element('li')
    item.append(element('span', { text: entry.text }), element('span', { className: 'when', text: ago(entry.at) }))
    list.append(item)
  }
  content.append(list)
}

/** The worktrees this tab can be handed to. */
function renderHandOver(state) {
  if (!isDrivableUrl(state.tabUrl)) {
    content.append(element('h2', { text: 'Can’t hand this tab over' }))
    content.append(element('p', { text: 'Chrome doesn’t let extensions drive this page.' }))
    return
  }
  content.append(element('div', { className: 'caps', text: 'Hand this tab to' }))
  if (state.worktrees.length === 0) {
    content.append(element('p', { className: 'detail', text: 'Open a repository in Grove to see its worktrees.' }))
    return
  }
  const list = element('div', { className: 'worktrees' })
  for (const worktree of state.worktrees) list.append(worktreeButton(worktree))
  content.append(list)
}

/** One worktree to hand the tab to. */
function worktreeButton(worktree) {
  const button = element('button', { className: 'worktree' })
  button.append(element('span', { text: worktree.name }), element('span', { className: 'branch', text: worktree.branch }))
  button.title = worktree.path
  button.addEventListener('click', () => void ask({ type: 'hand-over', worktreeId: worktree.id }))
  return button
}

/** The other tabs Grove has, so it's clear what else is handed over. */
function renderOthers(state) {
  const others = state.served.filter((served) => served.tabId !== state.tab)
  if (others.length === 0) return
  content.append(element('div', { className: 'caps', text: 'Other tabs in Grove' }))
  for (const other of others) content.append(element('p', { className: 'detail', text: other.worktreeName }))
}

/** How long ago a time was, briefly. */
function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** A DOM element with a class and text. */
function element(tag, { className, text } = {}) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Opens on the active tab, then follows the service worker's changes and keeps "ago" fresh. */
async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab) activeTabId = tab.id
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'changed') void ask({ type: 'state' })
  })
  setInterval(() => {
    if (lastState) render(lastState)
  }, 1000)
  await ask({ type: 'opened' })
}

void start()
