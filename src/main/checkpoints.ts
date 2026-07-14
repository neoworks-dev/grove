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
import type { CheckpointMeta, CheckpointTrigger } from '../shared/types'

// Machine identity for checkpoint commits, so they never depend on (or pollute)
// the user's configured git author.
const CHECKPOINT_ENV = {
  GIT_AUTHOR_NAME: 'grove-checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@grove.local',
  GIT_COMMITTER_NAME: 'grove-checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@grove.local'
}

// Default retention per worktree. Safety checkpoints (pre-restore/pre-merge) are
// exempt from eviction.
const DEFAULT_CAP = 50
const EXEMPT_TRIGGERS: ReadonlySet<CheckpointTrigger> = new Set(['pre-restore', 'pre-merge'])

// Minimum spacing between snapshots for one worktree; back-to-back triggers
// (e.g. a user message immediately followed by a turn-end) coalesce.
const MIN_SNAPSHOT_INTERVAL_MS = 750

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

export interface CheckpointEvents {
  // Persist the full per-worktree metadata map (mirrors the agentChats pattern).
  onChange?: (all: Record<string, CheckpointMeta[]>) => void
}

export interface SnapshotContext {
  agent?: string
  chatId?: string
  note?: string
}

export class CheckpointManager {
  private metadata = new Map<string, CheckpointMeta[]>()
  private lastSnapshotAt = new Map<string, number>()
  // Serialize snapshots per worktree so two triggers can't race the index.
  private chains = new Map<string, Promise<unknown>>()

  constructor(private events: CheckpointEvents = {}) {}

  // Load persisted metadata on repo open.
  hydrate(map: Record<string, CheckpointMeta[]>): void {
    this.metadata = new Map(Object.entries(map).map(([key, list]) => [key, list.map((m) => ({ ...m }))]))
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
    const next = prior
      .catch(() => {})
      .then(() => this.runSnapshot(worktreePath, trigger, ctx))
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
    const isSafety = EXEMPT_TRIGGERS.has(trigger)
    const last = this.lastSnapshotAt.get(worktreePath) ?? 0
    // Safety checkpoints (pre-restore/pre-merge) must never be debounced away.
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
      note: ctx.note
    }
    list.push(meta)
    this.metadata.set(worktreePath, list)
    this.lastSnapshotAt.set(worktreePath, now)
    await this.prune(worktreePath, DEFAULT_CAP)
    this.events.onChange?.(this.all())
    return meta
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
    const preRestore = await this.snapshot(worktreePath, 'pre-restore')

    const git = gitFor(worktreePath)
    const tree = (await git.raw(['rev-parse', `${commit}^{tree}`])).trim()
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
    const evictable = list.filter((m) => !EXEMPT_TRIGGERS.has(m.trigger))
    let overflow = evictable.length - cap
    if (overflow <= 0) return

    const git = gitFor(worktreePath)
    const kept: CheckpointMeta[] = []
    for (const meta of list) {
      if (overflow > 0 && !EXEMPT_TRIGGERS.has(meta.trigger)) {
        overflow -= 1
        await git.raw(['update-ref', '-d', `${refPrefix(worktreePath)}/${meta.n}`]).catch(() => {})
        continue
      }
      kept.push(meta)
    }
    this.metadata.set(worktreePath, kept)
  }
}
