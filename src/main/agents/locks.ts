// Cross-agent file-edit coordination. When several agents run in one worktree,
// the backend must stop two of them writing the same file at once. Enforcement
// happens at the tool-permission gate (claude.ts canUseTool): a mutating file
// tool acquires a lock on its target before the edit; a second agent's attempt
// on a held file is denied-with-message so the model backs off and retries.
//
// The owner key is the running agent's `worktreeId::name` (one live run per
// key, so it uniquely identifies the holder). Locks are in-memory only — a
// crashed main process drops every lock, which is the desired self-healing.

// A lock older than this is treated as stale and reclaimable, so a wedged run
// that never released can't hold a file forever.
const STALE_MS = 5 * 60 * 1000

interface Lock {
  owner: string // ownerKey (worktreeId::name)
  ownerName: string // agent name, for the deny message
  acquiredAt: number
}

export interface LockAcquireResult {
  ok: boolean
  // When ok is false, the name of the agent currently holding a conflicting file.
  heldBy?: string
}

export class FileLockManager {
  // Normalized absolute path → lock.
  private locks = new Map<string, Lock>()

  // Injectable clock for tests.
  constructor(private now: () => number = () => Date.now()) {}

  private isHeldByOther(path: string, ownerKey: string): Lock | null {
    const existing = this.locks.get(path)
    if (!existing) return null
    if (existing.owner === ownerKey) return null
    if (this.now() - existing.acquiredAt >= STALE_MS) return null // reclaimable
    return existing
  }

  // Acquire all paths for the owner, all-or-nothing. If any path is held by a
  // different (non-stale) owner, acquires nothing and reports the holder.
  tryAcquire(ownerKey: string, ownerName: string, paths: string[]): LockAcquireResult {
    for (const path of paths) {
      const conflict = this.isHeldByOther(path, ownerKey)
      if (conflict) return { ok: false, heldBy: conflict.ownerName }
    }
    const at = this.now()
    for (const path of paths) this.locks.set(path, { owner: ownerKey, ownerName, acquiredAt: at })
    return { ok: true }
  }

  // Release every lock held by an owner (turn boundary / run teardown).
  releaseOwner(ownerKey: string): void {
    for (const [path, lock] of this.locks) {
      if (lock.owner === ownerKey) this.locks.delete(path)
    }
  }

  // Paths currently locked (for surfacing lock state in the UI).
  heldPaths(): Array<{ path: string; ownerName: string }> {
    const now = this.now()
    const held: Array<{ path: string; ownerName: string }> = []
    for (const [path, lock] of this.locks) {
      if (now - lock.acquiredAt < STALE_MS) held.push({ path, ownerName: lock.ownerName })
    }
    return held
  }
}
