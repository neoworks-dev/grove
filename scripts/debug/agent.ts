// Agent control for the debug harness. Everything here rides on
// debug.renderer.eval calling window.workbench.agents.*, which is the same
// surface the UI itself uses — so a scenario exercises the real path rather than
// a parallel one that could drift from it.

import type { GroveClient } from '../../sdk/src/client/node'
import { evaluate, pollUntil } from './client'

export interface PendingPermission {
  id: string
  toolName: string
  path: string | null
  agent: string
  chatId: string
  worktreeId: string
}

export interface QueuedReview {
  id: string
  origin: string
  files: { relPath: string; hunks: number }[]
  permissionId?: string
}

/** The worktree the UI currently has selected — the target for agent runs. */
export function selectedWorktree(grove: GroveClient): Promise<string | null> {
  return evaluate(grove, `window.__grove_debug.store.selectedWorktreeId`) as Promise<string | null>
}

/** Agent adapter names the app knows about. */
export function agentNames(grove: GroveClient): Promise<string[]> {
  return evaluate(
    grove,
    `Object.keys(window.__grove_debug.store.agentConfigs)`
  ) as Promise<string[]>
}

/**
 * Start a run. `mode` is the SDK permission mode — 'default' gates every write
 * behind a permission prompt, which is what the review flow needs.
 */
export async function start(
  grove: GroveClient,
  options: { worktreeId: string; agent: string; prompt: string; mode?: string }
): Promise<unknown> {
  const launch = JSON.stringify({ prompt: options.prompt, mode: options.mode ?? 'default' })
  return evaluate(
    grove,
    `window.workbench.agents.start(
      ${JSON.stringify(options.worktreeId)},
      ${JSON.stringify(options.agent)},
      ${launch}
    )`
  )
}

export async function send(
  grove: GroveClient,
  options: { worktreeId: string; agent: string; text: string }
): Promise<unknown> {
  return evaluate(
    grove,
    `window.workbench.agents.send(
      ${JSON.stringify(options.worktreeId)},
      ${JSON.stringify(options.agent)},
      ${JSON.stringify(options.text)}
    )`
  )
}

export async function stop(
  grove: GroveClient,
  options: { worktreeId: string; agent: string; chatId: string }
): Promise<unknown> {
  return evaluate(
    grove,
    `window.workbench.agents.stop(
      ${JSON.stringify(options.worktreeId)},
      ${JSON.stringify(options.agent)},
      ${JSON.stringify(options.chatId)}
    )`
  )
}

export function pendingPermissions(grove: GroveClient): Promise<PendingPermission[]> {
  return evaluate(
    grove,
    `window.__grove_debug.store.pendingPermissions.map((request) => ({
      id: request.id,
      toolName: request.toolName,
      path: request.path,
      agent: request.agent,
      chatId: request.chatId,
      worktreeId: request.worktreeId
    }))`
  ) as Promise<PendingPermission[]>
}

/** Block until the agent asks permission for a tool, or give up. */
export function awaitPermission(
  grove: GroveClient,
  timeoutMs = 60_000
): Promise<PendingPermission | null> {
  return pollUntil<PendingPermission>(
    grove,
    `(() => {
      const [first] = window.__grove_debug.store.pendingPermissions
      if (!first) return null
      return { id: first.id, toolName: first.toolName, path: first.path, agent: first.agent, chatId: first.chatId, worktreeId: first.worktreeId }
    })()`,
    timeoutMs
  )
}

export async function respondPermission(
  grove: GroveClient,
  id: string,
  decision: { behavior: 'allow'; remember?: boolean } | { behavior: 'deny'; message: string }
): Promise<unknown> {
  const payload =
    decision.behavior === 'allow'
      ? { behavior: 'allow', remember: decision.remember === true }
      : decision
  return evaluate(
    grove,
    `window.workbench.agents.respondPermission(${JSON.stringify(id)}, ${JSON.stringify(payload)})`
  )
}

export function queuedReviews(grove: GroveClient): Promise<QueuedReview[]> {
  return evaluate(
    grove,
    `window.__grove_debug.review.queue.map((batch) => ({
      id: batch.id,
      origin: batch.origin,
      permissionId: batch.permissionId,
      files: batch.files.map((file) => ({ relPath: file.relPath, hunks: file.hunks.length }))
    }))`
  ) as Promise<QueuedReview[]>
}

/** Block until a review batch is raised, or give up. */
export function awaitReview(grove: GroveClient, timeoutMs = 60_000): Promise<QueuedReview | null> {
  return pollUntil<QueuedReview>(
    grove,
    `(() => {
      const [batch] = window.__grove_debug.review.queue
      if (!batch) return null
      return {
        id: batch.id,
        origin: batch.origin,
        permissionId: batch.permissionId,
        files: batch.files.map((file) => ({ relPath: file.relPath, hunks: file.hunks.length }))
      }
    })()`,
    timeoutMs
  )
}

export async function openReview(grove: GroveClient, batchId: string): Promise<unknown> {
  return evaluate(grove, `window.__grove_debug.review.open(${JSON.stringify(batchId)})`)
}

/** Set one hunk's verdict, exactly as clicking the overlay would. */
export async function decideHunk(
  grove: GroveClient,
  relPath: string,
  hunkIndex: number,
  status: 'accepted' | 'rejected' | 'pending'
): Promise<unknown> {
  return evaluate(
    grove,
    `window.__grove_debug.review.decide(${JSON.stringify(relPath)}, ${hunkIndex}, ${JSON.stringify(status)})`
  )
}

export async function commentHunk(
  grove: GroveClient,
  relPath: string,
  hunkIndex: number,
  comment: string
): Promise<unknown> {
  return evaluate(
    grove,
    `window.__grove_debug.review.comment(${JSON.stringify(relPath)}, ${hunkIndex}, ${JSON.stringify(comment)})`
  )
}

/** Apply the current verdicts and report back to the agent. */
export async function finishReview(grove: GroveClient): Promise<unknown> {
  return evaluate(grove, `window.__grove_debug.review.finish()`)
}

/** Whatever the app last surfaced as an error, so a scenario can report it. */
export function lastError(grove: GroveClient): Promise<string | null> {
  return evaluate(grove, `window.__grove_debug.store.error`) as Promise<string | null>
}
