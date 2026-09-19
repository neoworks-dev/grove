// How a QA command says what it means to act on.
//
// The driver is invoked once per action and keeps nothing between calls, so a
// target has to be expressible as a string on a command line. Bare text is the
// common case — the accessible name a person would read off the screen — and
// the prefixed forms exist for what has no name: a divider, a canvas, a point.

export type Target =
  | { kind: 'ref'; ref: string }
  | { kind: 'leaf'; leafId: string }
  | { kind: 'gutter'; splitId: string; index: number }
  | { kind: 'name'; name: string; role?: string }
  | { kind: 'text'; text: string }
  | { kind: 'testid'; testId: string }
  | { kind: 'css'; selector: string }
  | { kind: 'point'; x: number; y: number }

/** The roles a bare name is looked for in, in this order. */
export const NAME_ROLES = [
  'button',
  'tab',
  'treeitem',
  'link',
  'menuitem',
  'option',
  'row',
  'checkbox',
  'textbox'
]

/**
 * Read a target off the command line.
 *
 * Throws rather than guessing when a prefixed form is malformed: a click that
 * silently lands somewhere else is worse than one that does not happen.
 */
export function parseTarget(input: string): Target {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error('empty target')

  const separator = trimmed.indexOf('=')
  if (separator === -1) return bareTarget(trimmed)

  const prefix = trimmed.slice(0, separator)
  const value = trimmed.slice(separator + 1)
  if (prefix === 'text') return { kind: 'text', text: requireValue(value, 'text') }
  if (prefix === 'testid') return { kind: 'testid', testId: requireValue(value, 'testid') }
  if (prefix === 'css') return { kind: 'css', selector: requireValue(value, 'css') }
  if (prefix === 'at') return pointTarget(value)
  if (prefix === 'role') return roleTarget(value)
  // An unprefixed name can contain '=' — "width = 40" is a plausible label.
  return bareTarget(trimmed)
}

/**
 * A ref, a pane, a gutter — or otherwise an accessible name.
 *
 * The three structural forms are the ids `probe` prints, and they are shaped
 * distinctly enough (`e12`, `leaf-3`, `split-1:0`) that no label a person reads
 * off the screen can be mistaken for one.
 */
function bareTarget(input: string): Target {
  if (/^e[0-9]+$/.test(input)) return { kind: 'ref', ref: input }
  if (/^leaf-[0-9]+$/.test(input)) return { kind: 'leaf', leafId: input }
  const gutter = /^(split-[0-9]+):([0-9]+)$/.exec(input)
  if (gutter) return { kind: 'gutter', splitId: gutter[1], index: Number(gutter[2]) }
  return { kind: 'name', name: input }
}

/** `role=button:Save` — a name looked for in one role rather than all of them. */
function roleTarget(value: string): Target {
  const separator = value.indexOf(':')
  if (separator === -1) throw new Error(`role target needs a name: role=${value}:<name>`)
  const role = value.slice(0, separator)
  const name = value.slice(separator + 1)
  if (role.length === 0 || name.length === 0) {
    throw new Error(`role target needs both parts: role=<role>:<name>, got role=${value}`)
  }
  return { kind: 'name', name, role }
}

/** `at=820,460` — a point in the window, for what has no element to name. */
function pointTarget(value: string): Target {
  const parts = value.split(',')
  if (parts.length !== 2) throw new Error(`point target is at=<x>,<y>, got at=${value}`)
  const x = Number(parts[0])
  const y = Number(parts[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`point target needs two numbers, got at=${value}`)
  }
  return { kind: 'point', x, y }
}

function requireValue(value: string, prefix: string): string {
  if (value.length === 0) throw new Error(`${prefix} target is empty`)
  return value
}

/** How a target reads back in an error or a log line. */
export function describeTarget(target: Target): string {
  if (target.kind === 'ref') return target.ref
  if (target.kind === 'leaf') return `pane ${target.leafId}`
  if (target.kind === 'gutter') return `gutter ${target.splitId}:${target.index}`
  if (target.kind === 'name') {
    if (target.role === undefined) return `"${target.name}"`
    return `${target.role} "${target.name}"`
  }
  if (target.kind === 'text') return `text "${target.text}"`
  if (target.kind === 'testid') return `testid ${target.testId}`
  if (target.kind === 'css') return `css ${target.selector}`
  return `point ${target.x},${target.y}`
}
