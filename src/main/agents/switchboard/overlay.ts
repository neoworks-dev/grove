// The desktop overlay (neoworks/overlay) serves MCP tools that put things on
// the user's screen: point at a window, circle something, pin a note, talk
// them through it. When it is running, every agent session gets them, so an
// answer to a ramble can show as well as say. How to read and answer a ramble
// is the overlay's own skill, offered next to the plugins' skills rather than
// written into grove's prompt.

import type { McpServer } from '@neoworks/harness'
import type { GroveSkill } from '../harness'

const OVERLAY_ORIGIN = 'http://127.0.0.1:7831'
/** What the overlay answers on its root, so another server on the port isn't mistaken for it. */
const OVERLAY_BANNER = 'neoworks overlay'
const PROBE_TIMEOUT_MS = 300
const OVERLAY_SERVER = 'overlay'

/** The overlay's skill as last fetched; null while the overlay isn't running. */
let skill: GroveSkill | null = null

/** The overlay's MCP server, or null when the overlay isn't running. */
export async function overlayMcpServer(): Promise<McpServer | null> {
  if (!(await overlayRunning())) {
    skill = null
    return null
  }
  skill = await fetchSkill()
  return { type: 'http', name: OVERLAY_SERVER, url: `${OVERLAY_ORIGIN}/mcp`, headers: [] }
}

/** The overlay's skills, as of the last session started. */
export function overlaySkills(): GroveSkill[] {
  if (skill === null) return []
  return [skill]
}

/**
 * Whether a call to `name` can run without asking: the overlay's tools only
 * show things on the screen, so asking would stop a walkthrough at every
 * step. Typing that ends with Return can run a command, so that still asks.
 */
export function overlayRunsUnasked(name: string, input: unknown): boolean {
  if (!name.startsWith(`mcp__${OVERLAY_SERVER}__`)) return false
  return !pressesEnter(input)
}

/** A `type_text` call that ends with Return, directly or through `more_tools`. */
function pressesEnter(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  const fields = input as Record<string, unknown>
  if (fields.enter === true) return true
  const nested = fields.args
  if (nested === null || typeof nested !== 'object') return false
  return (nested as Record<string, unknown>).enter === true
}

async function overlayRunning(): Promise<boolean> {
  try {
    const response = await fetch(OVERLAY_ORIGIN, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const body = await response.text()
    return body.startsWith(OVERLAY_BANNER)
  } catch {
    return false
  }
}

async function fetchSkill(): Promise<GroveSkill | null> {
  try {
    const response = await fetch(`${OVERLAY_ORIGIN}/skill`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return null
    return skillOf(await response.json())
  } catch {
    // An overlay from before it served the skill still has its tools.
    return null
  }
}

function skillOf(value: unknown): GroveSkill | null {
  if (value === null || typeof value !== 'object') return null
  const { name, description, instructions } = value as Record<string, unknown>
  if (typeof name !== 'string' || typeof description !== 'string' || typeof instructions !== 'string') {
    return null
  }
  return { name, description, instructions }
}
