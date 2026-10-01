// What each of an agent's tool calls did to the worktree, step by step.
//
// The recorder follows every session's log. When a call that may write is
// first reported, it captures the working tree; when the call settles, it
// captures it again. A call that changed something becomes a step: both trees,
// the files between them, and the turn it ran in. The replay view walks these.
//
// Trees are captured the way checkpoints are (a throwaway index, never the real
// one) and pinned under a ref per session, so the checkpoint cap cannot evict
// them while the session exists. A call is attributed everything that changed
// while it ran, which is exact for one agent working alone and an honest
// over-count when the user or another agent edits the same worktree meanwhile.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolCallUpdate } from '@neoworks/harness'
import type { TreeFileChange } from '../../shared/types'
import type {
  AgentEditStep,
  ReplayTurn,
  SessionEvent,
  SessionReplay
} from '../../shared/agents'
import { updateOf, isSettled } from './acpLog'
import type { SessionStore, StoredSession } from './store'

const STEPS_FILE = 'steps.json'

// Kinds ACP gives calls that only look. Anything else — edits, commands, a
// tool of grove's or a plugin's reported as `other` — may write.
const READ_ONLY_KINDS: ReadonlySet<string> = new Set([
  'read',
  'search',
  'think',
  'fetch',
  'switch_mode'
])

/** The git work the recorder needs, so tests can stand it in. */
export interface StepTrees {
  /** The working tree right now, as a tree object. */
  capture(worktreePath: string): Promise<string>
  /** Keeps two trees reachable for as long as the session is. */
  pin(worktreePath: string, sessionId: string, before: string, after: string): Promise<void>
  /** Drops what `pin` kept for a session. */
  unpin(worktreePath: string, sessionId: string): Promise<void>
  diff(worktreePath: string, from: string, to: string): Promise<TreeFileChange[]>
}

export interface EditStepRecorderOptions {
  store: SessionStore
  trees: StepTrees
  /** Tells the renderer a session has a new step. */
  publish(sessionId: string, step: AgentEditStep): void
}

/** A call that may write, between its first report and its settling. */
interface OpenCall {
  seq: number
  title: string
  kind: string
  before: Promise<string | null>
}

/** The private ref a session's step trees are pinned under. */
export function stepsRef(sessionId: string): string {
  return `refs/workbench/agent-steps/${sessionId}`
}

export class EditStepRecorder {
  private open = new Map<string, OpenCall>()
  private steps = new Map<string, AgentEditStep[]>()
  // One write at a time per session, so steps land in the order calls settled.
  private chains = new Map<string, Promise<unknown>>()

  constructor(private options: EditStepRecorderOptions) {}

  /** Follow the event log. Returns the inverse, as every effect must. */
  watch(): () => void {
    return this.options.store.subscribe((event) => this.handle(event))
  }

  /** The steps a session has recorded, oldest first. */
  async stepsOf(sessionId: string): Promise<AgentEditStep[]> {
    const cached = this.steps.get(sessionId)
    if (cached) return cached
    const loaded = await this.read(sessionId)
    // A step recorded while the file was being read is already in the cache.
    const raced = this.steps.get(sessionId)
    if (raced) return raced
    this.steps.set(sessionId, loaded)
    return loaded
  }

  /** The session as the replay view walks it: each turn with the edits it made. */
  async replay(sessionId: string): Promise<SessionReplay> {
    const session = await this.options.store.require(sessionId)
    const events = await this.options.store.eventsSince(sessionId, 0)
    const steps = await this.stepsOf(sessionId)
    return {
      sessionId,
      title: session.title,
      workspaceRoot: session.workspaceRoot,
      turns: replayTurns(events, steps)
    }
  }

  /** A removed session's trees no longer need keeping. */
  async forget(session: StoredSession): Promise<void> {
    this.steps.delete(session.id)
    await this.options.trees.unpin(session.workspaceRoot, session.id)
  }

  private handle(event: SessionEvent): void {
    const update = updateOf(event)
    if (!update) return
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const key = callKey(event.sessionId, update.toolCallId)
    if (update.sessionUpdate === 'tool_call') this.begin(event, update, key)
    const call = this.open.get(key)
    if (!call) return
    if (update.title) call.title = update.title
    if (!update.status || !isSettled(update.status)) return
    this.open.delete(key)
    // Captured now, not when the queue reaches it: a later call may already be
    // writing by then.
    const session = this.options.store.peek(event.sessionId)
    if (!session) return
    const after = this.options.trees.capture(session.workspaceRoot).catch(() => null)
    this.enqueue(event.sessionId, () => this.settle(event, update.toolCallId, call, after))
  }

  /** A call that may write was reported: remember the tree it starts from. */
  private begin(event: SessionEvent, update: ToolCallUpdate, key: string): void {
    if (this.open.has(key)) return
    let kind = 'other'
    if (update.kind) kind = update.kind
    if (READ_ONLY_KINDS.has(kind)) return
    const session = this.options.store.peek(event.sessionId)
    if (!session) return
    let title = ''
    if (update.title) title = update.title
    this.open.set(key, {
      seq: event.seq,
      title,
      kind,
      before: this.options.trees.capture(session.workspaceRoot).catch(() => null)
    })
  }

  /** A call settled: if the worktree changed while it ran, that is a step. */
  private async settle(
    event: SessionEvent,
    toolCallId: string,
    call: OpenCall,
    afterTree: Promise<string | null>
  ): Promise<void> {
    const session = this.options.store.peek(event.sessionId)
    if (!session) return
    const [before, after] = await Promise.all([call.before, afterTree])
    if (!before || !after || after === before) return
    const root = session.workspaceRoot

    const files = await this.options.trees.diff(root, before, after)
    if (files.length === 0) return
    await this.options.trees.pin(root, session.id, before, after)

    const steps = await this.stepsOf(session.id)
    const step: AgentEditStep = {
      index: steps.length + 1,
      turnSeq: turnSeqAt(this.options.store.peekEvents(session.id), call.seq),
      seq: call.seq,
      toolCallId,
      title: call.title,
      kind: call.kind,
      at: event.createdAt,
      before,
      after,
      files
    }
    steps.push(step)
    await writeFile(this.fileOf(session.id), JSON.stringify(steps))
    this.options.publish(session.id, step)
  }

  /** Runs `work` after the session's earlier work, never failing the chain. */
  private enqueue(sessionId: string, work: () => Promise<void>): void {
    const prior = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prior.then(work).catch((error: Error) => {
      console.error(`[agents] recording an edit step failed: ${error.message}`)
    })
    this.chains.set(sessionId, next)
  }

  /** The session's steps file, or none when it has not recorded any. */
  private async read(sessionId: string): Promise<AgentEditStep[]> {
    const text = await readFile(this.fileOf(sessionId), 'utf8').catch(() => '')
    if (text.length === 0) return []
    try {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed as AgentEditStep[]
    } catch {
      return []
    }
  }

  private fileOf(sessionId: string): string {
    return join(this.options.store.dirOf(sessionId), STEPS_FILE)
  }
}

/** Calls are keyed per session: two harnesses may hand out the same call id. */
function callKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

/** The message a call at `seq` answers: the last one sent before it, or null. */
export function turnSeqAt(events: readonly SessionEvent[], seq: number): number | null {
  let found: number | null = null
  for (const event of events) {
    if (event.seq >= seq) break
    if (event.type === 'user.message' || event.type === 'app.message') found = event.seq
  }
  return found
}

/**
 * The session's turns, each with the steps made while it ran. Edits recorded
 * before any message (a session resumed mid-call) gather under a turn of their
 * own at the start.
 */
export function replayTurns(
  events: readonly SessionEvent[],
  steps: readonly AgentEditStep[]
): ReplayTurn[] {
  const turns: ReplayTurn[] = []
  const bySeq = new Map<number, ReplayTurn>()
  for (const event of events) {
    const turn = turnOf(event)
    if (!turn) continue
    turns.push(turn)
    bySeq.set(event.seq, turn)
  }

  const orphans: AgentEditStep[] = []
  for (const step of steps) {
    let turn: ReplayTurn | undefined
    if (step.turnSeq !== null) turn = bySeq.get(step.turnSeq)
    if (turn) turn.steps.push(step)
    else orphans.push(step)
  }
  if (orphans.length > 0) {
    turns.unshift({ seq: null, at: orphans[0].at, from: '', prompt: '', steps: orphans })
  }
  return turns
}

/** The turn a message starts, or null for an event that is not a message. */
function turnOf(event: SessionEvent): ReplayTurn | null {
  if (event.type === 'user.message') {
    const text = event.content
      .map((block) => {
        if (block.type === 'text') return block.text
        return ''
      })
      .join('')
    return { seq: event.seq, at: event.createdAt, from: 'You', prompt: text, steps: [] }
  }
  if (event.type === 'app.message') {
    let from = event.label
    if (event.from) from = event.from
    return { seq: event.seq, at: event.createdAt, from, prompt: event.text, steps: [] }
  }
  return null
}
