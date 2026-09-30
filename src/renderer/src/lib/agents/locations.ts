// Finding the places an agent pointed at, as the code reads now.
//
// A location card holds line numbers from when the agent answered. Main looks
// each place up by the text it held, so the card can say which have moved or
// changed, and a click marks the lines the agent meant rather than whatever has
// slid into their place.

import {
  clearAgentMarks,
  markLinesInEditor,
  openFileAtLine,
  openFileInEditor,
  store
} from '../store.svelte'
import type { CodeLocation, LocationState, ResolvedLocation } from './types'

/**
 * Open a place an agent pointed at: the file with its lines marked and the
 * agent's notes above them, or just the file when no lines were named. Lines
 * that no longer read as they did are opened at but not marked, since the
 * mark would claim code the agent never saw; a removed file opens nothing.
 */
export function openLocationInEditor(
  root: string,
  location: CodeLocation,
  state: LocationState = 'current'
): void {
  const worktree = store.worktrees.find((entry) => entry.path === root)
  if (!worktree || state === 'removed') return
  let absolute = location.path
  if (!absolute.startsWith('/')) absolute = `${root}/${location.path}`
  if (location.startLine === undefined) {
    openFileInEditor(worktree.id, absolute)
    return
  }
  if (state === 'changed') {
    clearAgentMarks()
    openFileAtLine(worktree.id, absolute, location.startLine)
    return
  }
  markLinesInEditor(worktree.id, absolute, location.startLine, {
    endLine: location.endLine ?? location.startLine,
    note: location.note,
    annotations: location.annotations
  })
}

/** Where each location is now; as they were when the worktree is unknown or main cannot say. */
export async function resolveLocations(
  root: string,
  locations: CodeLocation[]
): Promise<ResolvedLocation[]> {
  const unresolved = locations.map((location) => ({ location, state: 'current' as const }))
  const worktree = store.worktrees.find((entry) => entry.path === root)
  if (!worktree) return unresolved
  // Card views live in Svelte state; a proxy cannot cross IPC.
  const plain = JSON.parse(JSON.stringify(locations)) as CodeLocation[]
  try {
    return await window.workbench.agents.resolveLocations(worktree.id, plain)
  } catch {
    return unresolved
  }
}
