// The selected worktree's git state, read once and shared by every git view:
// Source Control, the commit graph and whatever else shows branches or changes.
// Each view used to read its own copy, so an action in one left the others
// stale — the file watcher ignores `.git`, so a commit, a checkout or a fetch
// never reached them. Now every action reloads this, and `revision` tells the
// views that keep reads of their own (history pages, comparisons) to redo them.

import { untrack } from 'svelte'
import { store } from '../../../lib/store.svelte'
import { inlineEdit } from '../../../lib/inlineEdit.svelte'
import type {
  BranchStatus,
  DiffFile,
  MergeState,
  RefList,
  StashEntry
} from '../../../../../shared/types'

// Changes on disk arrive in bursts; the state reloads once they settle.
const RELOAD_DELAY_MS = 300

class GitState {
  // The worktree the fields below were read from.
  worktreeId = $state<string | null>(null)
  files = $state<DiffFile[]>([])
  merge = $state<MergeState>({ inProgress: false, files: [] })
  branchStatus = $state<BranchStatus | null>(null)
  refs = $state<RefList>({ local: [], remote: [], tags: [] })
  stashes = $state<StashEntry[]>([])
  loading = $state(false)
  // Bumped after every reload.
  revision = $state(0)

  #followers = 0
  #stopTracking: (() => void) | null = null
  // Only the newest reload may write, so a slow one cannot land over a fresher one.
  #latestReload = 0

  /** Re-reads everything for the selected worktree, then bumps the revision. */
  async reload(): Promise<void> {
    const id = store.selectedWorktreeId
    this.#latestReload += 1
    const reload = this.#latestReload
    if (!id) {
      this.#clear()
      return
    }
    this.loading = true
    try {
      const [files, merge, branchStatus, refs, stashes] = await Promise.all([
        window.workbench.git.changedFiles(id),
        window.workbench.git.mergeState(id),
        window.workbench.git.branchStatus(id),
        window.workbench.git.refs(id),
        window.workbench.git.stashes(id)
      ])
      if (reload !== this.#latestReload) return
      // A review of the working tree ends once its files are no longer changed.
      inlineEdit.settleWorkingTreeReview(
        id,
        files.map((file) => file.path)
      )
      this.worktreeId = id
      this.files = files
      this.merge = merge
      this.branchStatus = branchStatus
      this.refs = refs
      this.stashes = stashes
      this.revision += 1
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      if (reload === this.#latestReload) this.loading = false
    }
  }

  /**
   * Keeps the state following the selected worktree and the files in it for as
   * long as the returned stop has not been called. Every git view follows while
   * it is mounted, so nothing is read while none is open.
   */
  follow(): () => void {
    this.#followers += 1
    if (this.#followers === 1) this.#stopTracking = this.#track()
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      this.#followers -= 1
      if (this.#followers > 0 || !this.#stopTracking) return
      this.#stopTracking()
      this.#stopTracking = null
    }
  }

  /** Reloads at once on a worktree or branch switch, and once a burst of file changes settles. */
  #track(): () => void {
    return $effect.root(() => {
      $effect(() => {
        void store.selectedWorktreeId
        void store.selectedWorktree?.branch
        untrack(() => void this.reload())
      })

      let first = true
      $effect(() => {
        void store.fsVersion[store.selectedWorktreeId ?? '']
        if (first) {
          first = false
          return
        }
        const timer = setTimeout(() => void this.reload(), RELOAD_DELAY_MS)
        return () => clearTimeout(timer)
      })
    })
  }

  /** Empties the state when no worktree is selected. */
  #clear(): void {
    this.worktreeId = null
    this.files = []
    this.merge = { inProgress: false, files: [] }
    this.branchStatus = null
    this.refs = { local: [], remote: [], tags: [] }
    this.stashes = []
    this.loading = false
    this.revision += 1
  }
}

export const gitState = new GitState()
