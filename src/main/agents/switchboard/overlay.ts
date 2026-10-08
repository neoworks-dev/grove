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

/** The overlay's skill as last fetched; null while the overlay isn't running. */
let skill: GroveSkill | null = null

/** The overlay's MCP server, or null when the overlay isn't running. */
export async function overlayMcpServer(): Promise<McpServer | null> {
  if (!(await overlayRunning())) {
    skill = null
    return null
  }
  skill = await fetchSkill()
  return { type: 'http', name: 'overlay', url: `${OVERLAY_ORIGIN}/mcp`, headers: [] }
}

/** The overlay's skills, as of the last session started. */
export function overlaySkills(): GroveSkill[] {
  if (skill === null) return []
  return [skill]
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
