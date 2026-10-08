// The desktop overlay (neoworks/overlay) serves MCP tools that put things on
// the user's screen: point at a window, circle something, pin a note, talk
// them through it. When it is running, every agent session gets them, so an
// answer to a ramble can show as well as say.

import type { McpServer } from '@neoworks/harness'

const OVERLAY_ORIGIN = 'http://127.0.0.1:7831'
/** What the overlay answers on its root, so another server on the port isn't mistaken for it. */
const OVERLAY_BANNER = 'neoworks overlay'
const PROBE_TIMEOUT_MS = 300

/** The overlay's MCP server, or null when the overlay isn't running. */
export async function overlayMcpServer(): Promise<McpServer | null> {
  if (!(await overlayRunning())) return null
  return { type: 'http', name: 'overlay', url: `${OVERLAY_ORIGIN}/mcp`, headers: [] }
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
