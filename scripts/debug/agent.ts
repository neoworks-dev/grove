// Agent control for the debug harness. Everything here rides on
// debug.renderer.eval driving window.__grove_debug.nibSessions, which is the
// same store the AgentPane drives — so a scenario exercises the real path
// rather than a parallel one that could drift from it.
//
// Sessions live on the embedded nib server, so an "agent" here is a session id
// and a permission request is a nib tool call parked at `ask`.

import type { GroveClient } from '../../sdk/src/client/node'
import { evaluate, pollUntil } from './client'

export interface AgentSession {
  id: string
  title: string
  status: string
}

export interface PendingPermission {
  /** The nib toolUseId, which is also the review batch's permissionId. */
  id: string
  sessionId: string
  toolName: string
  path: string | null
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

/** Agent sessions belonging to a worktree, newest first. */
export function sessions(grove: GroveClient, worktreePath: string): Promise<AgentSession[]> {
  return evaluate(
    grove,
    `window.__grove_debug.nibSessions.forWorktree(${JSON.stringify(worktreePath)}).map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status
    }))`
  ) as Promise<AgentSession[]>
}

/**
 * Start a run in a fresh session. `mode` is grove's permission mode — 'default'
 * answers nothing automatically, which is what the gated review flow needs.
 *
 * The session is opened as well as created, because a stream is what makes its
 * approvals visible to `pendingPermissions`.
 */
export function start(
  grove: GroveClient,
  options: { worktreePath: string; prompt: string; mode?: string }
): Promise<unknown> {
  return evaluate(
    grove,
    `(async () => {
      const { nibSessions } = window.__grove_debug
      const sessionId = await nibSessions.create(${JSON.stringify(options.worktreePath)}, {
        title: 'Debug harness'
      })
      if (!sessionId) return { error: nibSessions.serverError || 'session was not created' }
      nibSessions.setMode(sessionId, ${JSON.stringify(options.mode ?? 'default')})
      await nibSessions.open(sessionId)
      await nibSessions.send(sessionId, [{
        type: 'user.message',
        content: [{ type: 'text', text: ${JSON.stringify(options.prompt)} }],
        deliverAs: 'steer'
      }])
      return { sessionId }
    })()`
  )
}

/** Say something to the worktree's active session, creating one if it has none. */
export function send(
  grove: GroveClient,
  options: { worktreePath: string; text: string }
): Promise<unknown> {
  return evaluate(
    grove,
    `window.__grove_debug.nibSessions.sendText(
      ${JSON.stringify(options.worktreePath)},
      ${JSON.stringify(options.text)}
    )`
  )
}

export function stop(grove: GroveClient, sessionId: string): Promise<unknown> {
  return evaluate(
    grove,
    `window.__grove_debug.nibSessions.send(${JSON.stringify(sessionId)}, [{ type: 'user.interrupt' }])`
  )
}

// Tool calls parked at `ask`, across every session the renderer is streaming.
const PENDING_PERMISSIONS_EXPRESSION = `(() => {
  const { nibSessions, nibTranscript } = window.__grove_debug
  const pending = []
  for (const sessionId of Object.keys(nibSessions.live)) {
    const session = nibSessions.live[sessionId]
    for (const item of nibTranscript.pendingApprovals(session.transcript)) {
      const input = item.input && typeof item.input === 'object' ? item.input : {}
      pending.push({
        id: item.toolUseId,
        sessionId,
        toolName: item.name,
        path: typeof input.path === 'string' ? input.path : null
      })
    }
  }
  return pending
})()`

export function pendingPermissions(grove: GroveClient): Promise<PendingPermission[]> {
  return evaluate(grove, PENDING_PERMISSIONS_EXPRESSION) as Promise<PendingPermission[]>
}

/** Block until the agent asks permission for a tool, or give up. */
export function awaitPermission(
  grove: GroveClient,
  timeoutMs = 60_000
): Promise<PendingPermission | null> {
  return pollUntil<PendingPermission>(
    grove,
    `(${PENDING_PERMISSIONS_EXPRESSION})[0] ?? null`,
    timeoutMs
  )
}

/**
 * Answer one parked tool call. `remember` maps to nib's session-wide always,
 * which is what the "don't ask again" affordance sends.
 */
export function respondPermission(
  grove: GroveClient,
  request: { sessionId: string; id: string },
  decision: { behavior: 'allow'; remember?: boolean } | { behavior: 'deny'; message: string }
): Promise<unknown> {
  const confirmation = {
    type: 'user.tool_confirmation',
    toolUseId: request.id,
    result: confirmationResultOf(decision),
    reason: decision.behavior === 'deny' ? decision.message : undefined
  }
  return evaluate(
    grove,
    `window.__grove_debug.nibSessions.send(
      ${JSON.stringify(request.sessionId)},
      [${JSON.stringify(confirmation)}]
    )`
  )
}

function confirmationResultOf(
  decision: { behavior: 'allow'; remember?: boolean } | { behavior: 'deny'; message: string }
): string {
  if (decision.behavior === 'deny') return 'deny'
  if (decision.remember === true) return 'always_session'
  return 'allow'
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
  return evaluate(
    grove,
    `window.__grove_debug.store.error || window.__grove_debug.nibSessions.serverError || null`
  ) as Promise<string | null>
}
