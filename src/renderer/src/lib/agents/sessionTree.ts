// Which sessions belong together.
//
// A session started by `spawn_agent` carries the session that started it, so the
// tabs can show the two as one family rather than as unrelated conversations
// that happen to sit next to each other. The labels are written by the main
// process (`src/main/agents/identity.ts`, `handoffBridge.ts`); the names are
// repeated here because the renderer only ever reads them.

import type { SessionMeta } from './types'

const PARENT_LABEL = 'grove.parent'
const AGENT_ID_LABEL = 'grove.agentId'

export interface SessionRow {
  session: SessionMeta
  /** 0 for a session the user started, 1+ for one an agent spawned. */
  depth: number
}

/** The agent that spawned this session, if one did. */
export function parentIdOf(session: SessionMeta): string | null {
  return session.labels[PARENT_LABEL] || null
}

/** The id other agents address this session by. */
export function agentIdOf(session: SessionMeta): string {
  return session.labels[AGENT_ID_LABEL] || session.id.slice(0, 8)
}

/** The session an agent id belongs to, or none when it has been deleted. */
export function sessionByAgentId(
  sessions: SessionMeta[],
  agentId: string
): SessionMeta | undefined {
  return sessions.find((session) => agentIdOf(session) === agentId)
}

/**
 * Sessions grouped into families, each led by one the user started.
 *
 * A spawned session follows the one that spawned it, however far apart the two
 * were created; a session whose parent is gone leads a family of its own rather
 * than disappearing from the strip.
 */
export function sessionFamilies(sessions: SessionMeta[]): SessionRow[][] {
  const known = new Set(sessions.map((session) => session.id))
  const childrenOf = new Map<string, SessionMeta[]>()
  const roots: SessionMeta[] = []

  for (const session of sessions) {
    const parentId = parentIdOf(session)
    if (!parentId || !known.has(parentId) || parentId === session.id) {
      roots.push(session)
      continue
    }
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), session])
  }

  return roots.map((root) => familyOf(root, childrenOf))
}

/** One family, parents before children. Depth is capped so the strip stays flat. */
function familyOf(root: SessionMeta, childrenOf: Map<string, SessionMeta[]>): SessionRow[] {
  const rows: SessionRow[] = [{ session: root, depth: 0 }]
  const queue: SessionRow[] = [...rows]
  const seen = new Set<string>([root.id])

  while (queue.length > 0) {
    const current = queue.shift() as SessionRow
    for (const child of childrenOf.get(current.session.id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      const row: SessionRow = { session: child, depth: Math.min(current.depth + 1, 2) }
      rows.push(row)
      queue.push(row)
    }
  }
  return rows
}
