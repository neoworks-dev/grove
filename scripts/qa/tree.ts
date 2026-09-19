// What `qa probe` prints: the app as a tree of panes, with what can be acted on
// inside each one.
//
// Text rather than JSON, and text rather than a screenshot. A picture of the app
// costs an agent thousands of tokens to be told what a dozen lines say exactly —
// which panes are open, which has focus, what is inside them and what to call it.
// The screenshot is for the questions only a picture answers: alignment,
// overlap, a label running under an icon, a panel that went blank.

import type { ProbeElement, Snapshot, TreeNode } from './snapshot'

/** Where element lists wrap, wide enough for a long label to stay on one line. */
const WRAP_COLUMNS = 96

/** The whole snapshot as the lines a reader sees. */
export function renderSnapshot(snapshot: Snapshot): string {
  const lines = [...headerLines(snapshot)]

  if (snapshot.tree === null) {
    lines.push('', 'no layout tree — the renderer never reported one')
  } else {
    lines.push('')
    lines.push(...nodeLines(snapshot.tree, '', snapshot))
  }

  if (snapshot.overlays.length > 0) {
    lines.push('', 'overlays (menus, modals, the top bar — outside the pane tree)')
    lines.push(...wrapElements(snapshot.overlays, '  '))
  }

  lines.push(...problemLines(snapshot))
  return lines.join('\n')
}

/** The session in two lines: where it is, what has focus, what has gone wrong. */
function headerLines(snapshot: Snapshot): string[] {
  const first = [`grove  ${snapshot.window.width}x${snapshot.window.height}`]
  if (snapshot.view) first.push(`view=${snapshot.view.id}`)
  if (snapshot.worktree) first.push(`worktree=${shortPath(snapshot.worktree)}`)
  if (snapshot.focusMode) first.push('focus-mode')
  if (snapshot.filter !== undefined) first.push(`filter=${JSON.stringify(snapshot.filter)}`)

  const second = [focusPart(snapshot)]
  if (snapshot.activeTab) second.push(`tab=${basename(snapshot.activeTab)}`)
  if (snapshot.agentSessions.length > 0) {
    const statuses = snapshot.agentSessions.map((session) => session.status).join(',')
    second.push(`agents=${snapshot.agentSessions.length} (${statuses})`)
  }
  if (snapshot.reviewQueue > 0) second.push(`review=${snapshot.reviewQueue}`)
  second.push(`errors=${snapshot.errors.count}`)

  return [first.join('  '), second.join('  ')]
}

/**
 * Which pane has focus, named by the pane it actually is.
 *
 * The renderer remembers a leaf id across view switches and layout rebuilds, so
 * it can name a pane this view does not have. Say that rather than printing an id
 * with nothing behind it — it means no pane holds focus, and keys go nowhere.
 */
function focusPart(snapshot: Snapshot): string {
  if (!snapshot.activeLeafId) return 'focus=none'
  const focused = findPane(snapshot.tree, snapshot.activeLeafId)
  if (focused === null) return `focus=none (${snapshot.activeLeafId} is not in this view)`
  return `focus=${focused.id} (${focused.paneTypeId})`
}

function findPane(
  node: TreeNode | null,
  leafId: string
): Extract<TreeNode, { kind: 'leaf' }> | null {
  if (node === null) return null
  if (node.kind === 'leaf') {
    if (node.id === leafId) return node
    return null
  }
  for (const child of node.children) {
    const found = findPane(child, leafId)
    if (found !== null) return found
  }
  return null
}

/**
 * One node and everything under it.
 *
 * Splits draw their children with box-drawing characters, and the gutter between
 * each pair gets a line of its own: it is a target (`split-1:0`), and naming it
 * is what stops a resize from being a guess at coordinates.
 */
function nodeLines(node: TreeNode, indent: string, snapshot: Snapshot): string[] {
  if (node.kind === 'leaf') return [`${indent}${paneLine(node)}`, ...paneElements(node, indent)]

  const lines = [`${indent}${splitLine(node)}`]
  node.children.forEach((child, index) => {
    if (index > 0) {
      const gutter = `${node.id}:${index - 1}`
      if (snapshot.gutters.includes(gutter)) {
        let arrow = '↕'
        if (node.direction === 'row') arrow = '↔'
        const parts = [`${indent}│  ${gutter}  ${arrow} gutter`]
        // The `+` on a gutter opens a pane in the gap, and it is the one control
        // that belongs to a divider rather than to either pane beside it.
        const own = snapshot.gutterElements[gutter]
        if (own && own.length > 0) parts.push(own.map(describeElement).join(' · '))
        lines.push(parts.join('  '))
      }
    }
    const last = index === node.children.length - 1
    const branch = last ? '└─ ' : '├─ '
    const childIndent = last ? '   ' : '│  '
    const rendered = nodeLines(child, `${indent}${childIndent}`, snapshot)
    // The first line of the child carries the branch; the rest keep the trunk.
    lines.push(`${indent}${branch}${rendered[0].slice(indent.length + childIndent.length)}`)
    lines.push(...rendered.slice(1))
  })
  return lines
}

function splitLine(node: Extract<TreeNode, { kind: 'split' }>): string {
  const shares = node.sizes.map((size) => `${Math.round(size * 100)}%`).join(' ')
  return `${node.id}  ${node.direction}  ${shares}`
}

/** A pane: its id, its type, how big it is, and what is odd about it. */
function paneLine(node: Extract<TreeNode, { kind: 'leaf' }>): string {
  const parts = [`${node.id}  ${node.paneTypeId}`]
  if (node.title.toLowerCase() !== node.paneTypeId.toLowerCase()) parts.push(`"${node.title}"`)
  parts.push(`${node.width}x${node.height}`)
  if (node.focused) parts.push('★focus')
  if (typeof node.sizePx === 'number') parts.push(`fixed=${node.sizePx}px`)
  if (node.registered === false) parts.push('UNREGISTERED (its plugin has not loaded)')
  if (node.paneState) parts.push(`state=${compactJson(node.paneState)}`)
  return parts.join('  ')
}

function paneElements(node: Extract<TreeNode, { kind: 'leaf' }>, indent: string): string[] {
  if (node.elements.length === 0) return [`${indent}     (nothing to act on)`]
  return wrapElements(node.elements, `${indent}     `)
}

/** Elements as `role "name" ref`, several to a line, wrapped on the indent. */
function wrapElements(elements: ProbeElement[], indent: string): string[] {
  const lines: string[] = []
  let current = ''
  for (const element of elements) {
    const text = describeElement(element)
    if (current.length === 0) {
      current = text
      continue
    }
    if (indent.length + current.length + text.length + 3 > WRAP_COLUMNS) {
      lines.push(indent + current)
      current = text
      continue
    }
    current = `${current} · ${text}`
  }
  if (current.length > 0) lines.push(indent + current)
  return lines
}

function describeElement(element: ProbeElement): string {
  let text = element.role
  if (element.name.length > 0) text = `${text} "${truncate(element.name, 44)}"`
  text = `${text} ${element.ref}`
  if (element.disabled) text = `${text} (disabled)`
  return text
}

/** Boot failures, store errors and the last few console errors, when there are any. */
function problemLines(snapshot: Snapshot): string[] {
  const lines: string[] = []
  if (snapshot.error) lines.push('', snapshot.error)
  if (snapshot.bootError) {
    lines.push('', 'boot error (the kernel or the app effects failed):')
    lines.push(`  ${firstLine(snapshot.bootError)}`)
  }
  if (snapshot.storeError) lines.push('', `store error: ${snapshot.storeError}`)
  if (snapshot.errors.recent.length > 0) {
    lines.push(
      '',
      `console errors (${snapshot.errors.count}, last ${snapshot.errors.recent.length} — "qa logs" for all):`
    )
    for (const entry of snapshot.errors.recent) lines.push(`  ${truncate(firstLine(entry), 140)}`)
  }
  return lines
}

/** Pane state, short enough to sit on the pane's own line. */
function compactJson(value: Record<string, unknown>): string {
  return truncate(JSON.stringify(value), 60)
}

function firstLine(value: string): string {
  return value.split('\n')[0]
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1]
}

/** Paths are long and mostly the same; the tail is what identifies them. */
function shortPath(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

/** One pane type per line: what to open it by, and whether it is already open. */
export interface PaneTypeEntry {
  id: string
  title: string
  slot?: string
  edge?: string
  rail?: boolean
  open?: string[]
  unavailable?: boolean
}

export function renderPaneTypes(entries: PaneTypeEntry[]): string {
  const idWidth = Math.max(...entries.map((entry) => entry.id.length), 4)
  const titleWidth = Math.max(...entries.map((entry) => entry.title.length), 5)

  const lines = entries.map((entry) => {
    const notes: string[] = []
    if (entry.slot) notes.push(`slot=${entry.slot}`)
    if (entry.edge) notes.push(`edge=${entry.edge}`)
    if (entry.rail) notes.push('rail')
    if (entry.unavailable) notes.push('unavailable here')
    if (entry.open) notes.push(`open: ${entry.open.join(' ')}`)
    return `${entry.id.padEnd(idWidth)}  ${entry.title.padEnd(titleWidth)}  ${notes.join('  ')}`.trimEnd()
  })

  return [`${entries.length} pane types — "qa pane <id>" opens one`, '', ...lines].join('\n')
}
