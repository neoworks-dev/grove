// Local-only working-tree checkpoints. Every checkpoint is a git commit built
// from a throwaway index (so HEAD, the real index, and the working tree are
// never touched) and pointed at by a private ref under refs/workbench/** that
// no default refspec pushes. Captures tracked changes, deletions, and untracked
// files (respecting .gitignore, like `git add -A`).
//
// worktreeId === worktree.path throughout this app (git.ts), so a single path
// string serves as both the git baseDir and the metadata-map key; it is hashed
// before use as a ref segment (a path is not a legal ref component).

import { simpleGit, type SimpleGit } from 'simple-git'
import { createHash, randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { rm } from 'fs/promises'
import type { CheckpointMeta, CheckpointTrigger, TreeFileChange } from '../shared/types'

// Machine identity for checkpoint commits, so they never depend on (or pollute)
// the user's configured git author.
const CHECKPOINT_ENV = {
  GIT_AUTHOR_NAME: 'grove-checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@grove.local',
  GIT_COMMITTER_NAME: 'grove-checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@grove.local'
}

// Default retention per worktree. Safety checkpoints (pre-restore/merge/rebase/reset) are
// exempt from eviction.
const DEFAULT_CAP = 50
const EXEMPT_TRIGGERS: ReadonlySet<CheckpointTrigger> = new Set([
  'pre-restore',
  'pre-merge',
  'pre-rebase',
  'pre-reset'
])

// Minimum spacing between snapshots for one worktree; back-to-back triggers
// (e.g. a user message immediately followed by a turn-end) coalesce.
const MIN_SNAPSHOT_INTERVAL_MS = 750

// Prompt snapshots are one per user message, are recorded even when nothing changed
// (each prompt must find its own), and are capped apart from the other triggers so
// a long session neither crowds them out nor is crowded out by them.
const PROMPT_TRIGGER: CheckpointTrigger = 'prompt-sent'
const PROMPT_CAP = 200

function gitFor(worktreePath: string): SimpleGit {
  return simpleGit({ baseDir: worktreePath })
}

// A child env with all inherited GIT_* vars stripped (a parent GIT_DIR/
// GIT_INDEX_FILE/GIT_EDITOR would corrupt these plumbing calls, and simple-git's
// safety plugin rejects some of them outright), plus the given overrides.
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue
    if (value !== undefined) base[key] = value
  }
  return { ...base, ...overrides }
}

function refPrefix(worktreePath: string): string {
  const hash = createHash('sha1').update(worktreePath).digest('hex').slice(0, 16)
  return `refs/workbench/checkpoints/${hash}`
}

async function headCommit(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.raw(['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

async function headTree(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.raw(['rev-parse', 'HEAD^{tree}'])).trim()
  } catch {
    return null
  }
}

// Build a tree object capturing the current working tree (tracked + untracked)
// via a throwaway index, without disturbing the real index/HEAD/worktree.
async function writeWorkingTree(worktreePath: string, hasHead: boolean): Promise<string> {
  const tmpIndex = join(tmpdir(), `grove-ckpt-${randomUUID()}.index`)
  const git = gitFor(worktreePath).env(childEnv({ GIT_INDEX_FILE: tmpIndex }))
  try {
    // Seed from HEAD so deletions relative to HEAD are recorded; skip on an
    // unborn branch (no HEAD to read).
    if (hasHead) await git.raw(['read-tree', 'HEAD'])
    await git.raw(['add', '-A'])
    return (await git.raw(['write-tree'])).trim()
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {})
  }
}

/** The working tree as a tree object, written without touching HEAD, the index or the files. */
export async function captureTree(worktreePath: string): Promise<string> {
  const head = await headCommit(gitFor(worktreePath))
  return writeWorkingTree(worktreePath, head !== null)
}

/**
 * Keeps a pair of trees reachable under `ref`, so gc cannot take them while
 * something still points at them by hash. Each call adds a commit for the
 * earlier tree and one for the later on top of whatever `ref` held.
 */
export async function pinTreePair(
  worktreePath: string,
  ref: string,
  earlier: string,
  later: string
): Promise<void> {
  const git = gitFor(worktreePath).env(childEnv(CHECKPOINT_ENV))
  const parents: string[] = []
  const current = await refCommit(git, ref)
  if (current) parents.push('-p', current)
  const first = (await git.raw(['commit-tree', earlier, ...parents, '-m', 'agent step: before'])).trim()
  const second = (await git.raw(['commit-tree', later, '-p', first, '-m', 'agent step: after'])).trim()
  await git.raw(['update-ref', ref, second])
}

/** Drops a ref `pinTreePair` kept trees under. A ref that is already gone is not an error. */
export async function unpinTrees(worktreePath: string, ref: string): Promise<void> {
  await gitFor(worktreePath)
    .raw(['update-ref', '-d', ref])
    .catch(() => {})
}

/** The commit a ref points at, or null when it does not exist. */
async function refCommit(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.raw(['rev-parse', '--verify', '--quiet', ref])).trim() || null
  } catch {
    return null
  }
}

/** Every file that differs between two trees, with its line counts. */
export async function diffTrees(
  worktreePath: string,
  from: string,
  to: string
): Promise<TreeFileChange[]> {
  if (from === to) return []
  const git = gitFor(worktreePath)
  const [statuses, counts] = await Promise.all([
    git.raw(['diff', '--no-renames', '--name-status', '-z', from, to]),
    git.raw(['diff', '--no-renames', '--numstat', '-z', from, to])
  ])
  const lineCounts = parseNumstatZ(counts)
  return parseNameStatusZ(statuses).map((entry) => {
    const lines = lineCounts.get(entry.path)
    if (!lines) return { ...entry, added: 0, removed: 0 }
    return { ...entry, ...lines }
  })
}

/** `git diff --name-status -z`: a status letter, then the path, each NUL-terminated. */
export function parseNameStatusZ(
  output: string
): { path: string; status: TreeFileChange['status'] }[] {
  const fields = output.split('\0')
  const entries: { path: string; status: TreeFileChange['status'] }[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = fields[index]
    const path = fields[index + 1]
    if (!letter || !path) continue
    entries.push({ path, status: statusOfLetter(letter) })
  }
  return entries
}

/** `git diff --numstat -z`: "added\tremoved\tpath", NUL-terminated; "-" for binary. */
export function parseNumstatZ(output: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>()
  for (const record of output.split('\0')) {
    const parts = record.split('\t')
    if (parts.length < 3) continue
    const path = parts.slice(2).join('\t')
    counts.set(path, { added: countOf(parts[0]), removed: countOf(parts[1]) })
  }
  return counts
}

/** A numstat count, or -1 for the "-" git writes for a binary file. */
function countOf(field: string): number {
  if (field === '-') return -1
  return Number.parseInt(field, 10)
}

/** What a name-status letter means for one file. */
function statusOfLetter(letter: string): TreeFileChange['status'] {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  return 'modified'
}

export interface CheckpointEvents {
  // Persist the full per-worktree metadata map (mirrors the agentChats pattern).
  onChange?: (all: Record<string, CheckpointMeta[]>) => void
}

export interface SnapshotContext {
  agent?: string
  chatId?: string
  note?: string
  sessionId?: string
  promptSeq?: number
}

/** The snapshot taken when a session's prompt was sent, or null when there is none. */
export function promptSnapshot(
  list: readonly CheckpointMeta[],
  sessionId: string,
  promptSeq: number
): CheckpointMeta | null {
  for (let index = list.length - 1; index >= 0; index--) {
    const meta = list[index]
    if (meta.trigger !== PROMPT_TRIGGER) continue
    if (meta.sessionId !== sessionId || meta.promptSeq !== promptSeq) continue
    return meta
  }
  return null
}

/** Every prompt snapshot a session has, oldest first. */
export function promptSnapshotsOf(
  list: readonly CheckpointMeta[],
  sessionId: string
): CheckpointMeta[] {
  return list.filter((meta) => meta.trigger === PROMPT_TRIGGER && meta.sessionId === sessionId)
}

export class CheckpointManager {
  private metadata = new Map<string, CheckpointMeta[]>()
  private lastSnapshotAt = new Map<string, number>()
  // Serialize snapshots per worktree so two triggers can't race the index.
  private chains = new Map<string, Promise<unknown>>()

  constructor(private events: CheckpointEvents = {}) {}

  // Load persisted metadata on repo open.
  hydrate(map: Record<string, CheckpointMeta[]>): void {
    this.metadata = new Map(
      Object.entries(map).map(([key, list]) => [key, list.map((m) => ({ ...m }))])
    )
  }

  all(): Record<string, CheckpointMeta[]> {
    return Object.fromEntries(this.metadata.entries())
  }

  list(worktreePath: string): CheckpointMeta[] {
    return [...(this.metadata.get(worktreePath) ?? [])]
  }

  // Take a checkpoint. Returns null when skipped (debounced or tree unchanged).
  // Runs are serialized per worktree via a promise chain.
  snapshot(
    worktreePath: string,
    trigger: CheckpointTrigger,
    ctx: SnapshotContext = {}
  ): Promise<CheckpointMeta | null> {
    const prior = this.chains.get(worktreePath) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(() => this.runSnapshot(worktreePath, trigger, ctx))
    this.chains.set(
      worktreePath,
      next.catch(() => {})
    )
    return next
  }

  private async runSnapshot(
    worktreePath: string,
    trigger: CheckpointTrigger,
    ctx: SnapshotContext
  ): Promise<CheckpointMeta | null> {
    const now = Date.now()
    const isPrompt = trigger === PROMPT_TRIGGER
    const isSafety = EXEMPT_TRIGGERS.has(trigger) || isPrompt
    const last = this.lastSnapshotAt.get(worktreePath) ?? 0
    // Safety checkpoints (pre-restore/merge/rebase/reset) and prompt snapshots must
    // never be debounced away.
    if (!isSafety && now - last < MIN_SNAPSHOT_INTERVAL_MS) return null

    const git = gitFor(worktreePath)
    const head = await headCommit(git)
    const tree = await writeWorkingTree(worktreePath, head !== null)

    const list = this.metadata.get(worktreePath) ?? []
    const previous = list[list.length - 1]
    // Skip if nothing changed since the last checkpoint (or since HEAD when
    // there is no prior checkpoint) — the cheap guard that makes checkpointing
    // on every turn affordable. Safety checkpoints still record a marker.
    if (!isSafety) {
      if (previous && previous.tree === tree) return null
      if (!previous && head && tree === (await headTree(git))) return null
    }

    const parents: string[] = []
    if (previous) parents.push(previous.commit)
    if (head) parents.push(head)

    const message = `checkpoint:${trigger}${ctx.note ? ` ${ctx.note}` : ''}`
    const commitArgs = ['commit-tree', tree]
    for (const parent of parents) commitArgs.push('-p', parent)
    commitArgs.push('-m', message)
    const commit = (await gitFor(worktreePath).env(childEnv(CHECKPOINT_ENV)).raw(commitArgs)).trim()

    const n = (previous?.n ?? 0) + 1
    await git.raw(['update-ref', `${refPrefix(worktreePath)}/${n}`, commit])

    const meta: CheckpointMeta = {
      n,
      commit,
      tree,
      ts: now,
      trigger,
      agent: ctx.agent,
      chatId: ctx.chatId,
      note: ctx.note,
      sessionId: ctx.sessionId,
      promptSeq: ctx.promptSeq
    }
    list.push(meta)
    this.metadata.set(worktreePath, list)
    this.lastSnapshotAt.set(worktreePath, now)
    await this.prune(worktreePath, DEFAULT_CAP)
    await this.pruneTrigger(worktreePath, PROMPT_TRIGGER, PROMPT_CAP)
    this.events.onChange?.(this.all())
    return meta
  }

  // Tree hash of the worktree as it stands right now, for use as a review
  // batch's baseline. Prefers a fresh checkpoint so the tree is held by a ref;
  // when the snapshot is skipped (debounced, or nothing changed) the last
  // checkpoint already describes the same state, and HEAD's tree covers a
  // worktree that has never been checkpointed.
  async baselineTree(worktreePath: string, ctx: SnapshotContext = {}): Promise<string | null> {
    const meta = await this.snapshot(worktreePath, 'review-baseline', ctx)
    if (meta) return meta.tree
    const list = this.metadata.get(worktreePath) ?? []
    const previous = list[list.length - 1]
    if (previous) return previous.tree
    return headTree(gitFor(worktreePath))
  }

  // Content of one worktree-relative path inside a checkpoint tree. Returns ''
  // for a path absent from the tree — a file the agent newly created.
  async readFromTree(worktreePath: string, tree: string, relPath: string): Promise<string> {
    try {
      return await gitFor(worktreePath).raw(['show', `${tree}:${relPath}`])
    } catch {
      return ''
    }
  }

  // Restore the working tree to a checkpoint's tree without moving HEAD or the
  // branch. Auto-checkpoints first so the restore is itself reversible.
  async restore(
    worktreePath: string,
    commit: string
  ): Promise<{ restoredTree: string; preRestore: CheckpointMeta | null }> {
    const list = this.metadata.get(worktreePath) ?? []
    if (!list.some((m) => m.commit === commit)) {
      throw new Error('unknown checkpoint')
    }
    const tree = (await gitFor(worktreePath).raw(['rev-parse', `${commit}^{tree}`])).trim()
    return this.restoreTree(worktreePath, tree)
  }

  /**
   * Restores the working tree to any tree object — an agent step's, say —
   * without moving HEAD or the branch, checkpointing first so it can be undone.
   */
  async restoreTree(
    worktreePath: string,
    tree: string
  ): Promise<{ restoredTree: string; preRestore: CheckpointMeta | null }> {
    const preRestore = await this.snapshot(worktreePath, 'pre-restore')

    const git = gitFor(worktreePath)
    // read-tree --reset -u makes the index and tracked worktree files match the
    // tree, deleting tracked files absent from it. Files created since the
    // snapshot remain untracked and are removed by clean. Then a mixed reset
    // moves the index back to HEAD so restored changes read as normal working
    // changes (untracked snapshot files stay on disk, now untracked again).
    await git.raw(['read-tree', '--reset', '-u', tree])
    await git.raw(['clean', '-fd'])
    const head = await headCommit(git)
    if (head) await git.raw(['reset', '-q'])
    return { restoredTree: tree, preRestore }
  }

  // Evict oldest non-safety checkpoints beyond the cap, deleting their refs.
  async prune(worktreePath: string, cap: number): Promise<void> {
    const list = this.metadata.get(worktreePath) ?? []
    const evictable = list.filter((m) => !EXEMPT_TRIGGERS.has(m.trigger) && m.trigger !== PROMPT_TRIGGER)
    let overflow = evictable.length - cap
    if (overflow <= 0) return

    const git = gitFor(worktreePath)
    const kept: CheckpointMeta[] = []
    for (const meta of list) {
      if (overflow > 0 && !EXEMPT_TRIGGERS.has(meta.trigger) && meta.trigger !== PROMPT_TRIGGER) {
        overflow -= 1
        await git.raw(['update-ref', '-d', `${refPrefix(worktreePath)}/${meta.n}`]).catch(() => {})
        continue
      }
      kept.push(meta)
    }
    this.metadata.set(worktreePath, kept)
  }

  /** Evicts the oldest checkpoints of one trigger beyond `cap`, deleting their refs. */
  private async pruneTrigger(
    worktreePath: string,
    trigger: CheckpointTrigger,
    cap: number
  ): Promise<void> {
    const list = this.metadata.get(worktreePath) ?? []
    const ofTrigger = list.filter((meta) => meta.trigger === trigger)
    const evicted = new Set(ofTrigger.slice(0, Math.max(0, ofTrigger.length - cap)))
    if (evicted.size === 0) return

    const git = gitFor(worktreePath)
    for (const meta of evicted) {
      await git.raw(['update-ref', '-d', `${refPrefix(worktreePath)}/${meta.n}`]).catch(() => {})
    }
    this.metadata.set(
      worktreePath,
      list.filter((meta) => !evicted.has(meta))
    )
  }
}
