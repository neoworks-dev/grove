// Watches worktree directories for file changes (chokidar) and emits events so
// the renderer can refresh the file tree, reload open files, and auto-open diffs.
// Watches a dynamic set of worktrees (the selected one plus any running agents).

import chokidar, { type FSWatcher } from 'chokidar'
import { relative, sep } from 'path'

export interface FsChange {
  worktreeId: string
  path: string
  relPath: string
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
}

const IGNORED_DIRECTORIES = ['.git', 'node_modules', '.workbench', '.worktrees', 'out', 'dist']

/**
 * Whether a path found under a watched worktree is one we never follow. Only the
 * part below the root is judged: a worktree of its own lives at
 * `<repo>/../.worktrees/<name>`, so matching the whole path would ignore the
 * root itself and leave that worktree — the one an agent is working in —
 * silently unwatched.
 */
export function isIgnoredPath(worktreePath: string, candidate: string): boolean {
  const relativePath = relative(worktreePath, candidate)
  if (relativePath === '') return false
  return relativePath.split(sep).some((segment) => IGNORED_DIRECTORIES.includes(segment))
}

export class WorktreeWatcher {
  // worktreeId (== path) -> watcher
  private watchers = new Map<string, FSWatcher>()

  constructor(private onChange: (change: FsChange) => void) {}

  // Reconcile the watched set to exactly these worktree paths.
  setWatched(worktreePaths: string[]): void {
    const wanted = new Set(worktreePaths)
    for (const [path, watcher] of this.watchers) {
      if (!wanted.has(path)) {
        void watcher.close()
        this.watchers.delete(path)
      }
    }
    for (const path of wanted) {
      if (!this.watchers.has(path)) this.add(path)
    }
  }

  private add(worktreePath: string): void {
    const watcher = chokidar.watch(worktreePath, {
      ignored: (candidate: string) => isIgnoredPath(worktreePath, candidate),
      ignoreInitial: true,
      persistent: true,
      depth: 20
    })
    const emit = (type: FsChange['type']) => (path: string) => {
      this.onChange({
        worktreeId: worktreePath,
        path,
        relPath: relative(worktreePath, path),
        type
      })
    }
    watcher
      .on('add', emit('add'))
      .on('change', emit('change'))
      .on('unlink', emit('unlink'))
      .on('addDir', emit('addDir'))
      .on('unlinkDir', emit('unlinkDir'))
    this.watchers.set(worktreePath, watcher)
  }

  async closeAll(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.close()
    }
    this.watchers.clear()
  }
}
