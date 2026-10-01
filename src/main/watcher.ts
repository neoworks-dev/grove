// Watches worktree directories for file changes (chokidar) and emits events so
// the renderer can refresh the file tree, reload open files, and auto-open diffs.
// Watches a dynamic set of worktrees (the selected one plus any running agents).
//
// What git ignores is not watched. chokidar holds an inotify watch per file, so
// following a gitignored dataset or build output costs hundreds of thousands of
// watches — past the system limit — and a run writing into it floods the app
// with events nobody reviews.

import chokidar, { type FSWatcher } from 'chokidar'
import { basename, relative, sep } from 'path'
import { ignoredDirectories, isIgnoredByGit } from './git'

export interface FsChange {
  worktreeId: string
  path: string
  relPath: string
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
}

const IGNORED_DIRECTORIES = ['.git', 'node_modules', '.workbench', '.worktrees', 'out', 'dist']

/** One watched worktree: its watcher once started, and what git ignores in it. */
interface WatchedWorktree {
  watcher: FSWatcher | null
  /** Directories, relative to the worktree, that git ignores; everything below one is ignored too. */
  gitIgnored: Set<string>
  closed: boolean
  /** Set once a watch error has been logged, so a full inotify table is reported once. */
  reportedError: boolean
}

/**
 * Whether a path found under a watched worktree is one we never follow. Only the
 * part below the root is judged: a worktree of its own lives at
 * `<repo>/../.worktrees/<name>`, so matching the whole path would ignore the
 * root itself and leave that worktree — the one an agent is working in —
 * silently unwatched.
 */
export function isIgnoredPath(
  worktreePath: string,
  candidate: string,
  gitIgnored: ReadonlySet<string> = new Set()
): boolean {
  const relativePath = relative(worktreePath, candidate)
  if (relativePath === '') return false
  const segments = relativePath.split(sep)
  if (segments.some((segment) => IGNORED_DIRECTORIES.includes(segment))) return true
  return isUnderIgnored(segments, gitIgnored)
}

/** Whether the path made of `segments`, or any directory above it, is in `gitIgnored`. */
function isUnderIgnored(segments: string[], gitIgnored: ReadonlySet<string>): boolean {
  if (gitIgnored.size === 0) return false
  for (let length = 1; length <= segments.length; length++) {
    if (gitIgnored.has(segments.slice(0, length).join('/'))) return true
  }
  return false
}

export class WorktreeWatcher {
  // worktreeId (== path) -> watch
  private watched = new Map<string, WatchedWorktree>()

  constructor(private onChange: (change: FsChange) => void) {}

  // Reconcile the watched set to exactly these worktree paths.
  setWatched(worktreePaths: string[]): void {
    const wanted = new Set(worktreePaths)
    for (const [path, entry] of this.watched) {
      if (!wanted.has(path)) {
        this.close(entry)
        this.watched.delete(path)
      }
    }
    for (const path of wanted) {
      if (!this.watched.has(path)) this.add(path)
    }
  }

  /** Registers a worktree straight away and starts watching it once git has said what it ignores. */
  private add(worktreePath: string): void {
    const entry: WatchedWorktree = {
      watcher: null,
      gitIgnored: new Set(),
      closed: false,
      reportedError: false
    }
    this.watched.set(worktreePath, entry)
    void this.start(worktreePath, entry)
  }

  private async start(worktreePath: string, entry: WatchedWorktree): Promise<void> {
    entry.gitIgnored = await readGitIgnored(worktreePath)
    if (entry.closed) return

    const watcher = chokidar.watch(worktreePath, {
      ignored: (candidate: string) => isIgnoredPath(worktreePath, candidate, entry.gitIgnored),
      ignoreInitial: true,
      persistent: true,
      depth: 20
    })
    entry.watcher = watcher

    const emit = (type: FsChange['type']) => (path: string) => {
      const relPath = relative(worktreePath, path)
      if (basename(path) === '.gitignore') void this.refreshGitIgnored(worktreePath, entry)
      this.onChange({ worktreeId: worktreePath, path, relPath, type })
    }
    watcher
      .on('add', emit('add'))
      .on('change', emit('change'))
      .on('unlink', emit('unlink'))
      .on('addDir', (path: string) => {
        void this.dropIfIgnored(worktreePath, entry, path)
        emit('addDir')(path)
      })
      .on('unlinkDir', emit('unlinkDir'))
      .on('error', (error: unknown) => this.reportError(worktreePath, entry, error))
  }

  /**
   * A directory created after the watch started is not in the list git gave at
   * the start. Ask git about it, and stop following it if it is ignored.
   */
  private async dropIfIgnored(worktreePath: string, entry: WatchedWorktree, path: string): Promise<void> {
    const relPath = relative(worktreePath, path)
    if (isUnderIgnored(relPath.split(sep), entry.gitIgnored)) return
    const ignored = await isIgnoredByGit(worktreePath, relPath).catch(() => false)
    if (!ignored || entry.closed) return
    entry.gitIgnored.add(relPath.split(sep).join('/'))
    entry.watcher?.unwatch(path)
  }

  /** Re-reads what git ignores after a .gitignore changed. Applies to what is found from now on. */
  private async refreshGitIgnored(worktreePath: string, entry: WatchedWorktree): Promise<void> {
    const gitIgnored = await readGitIgnored(worktreePath)
    if (entry.closed) return
    entry.gitIgnored = gitIgnored
  }

  private reportError(worktreePath: string, entry: WatchedWorktree, error: unknown): void {
    if (entry.reportedError) return
    entry.reportedError = true
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`file watcher for ${worktreePath}: ${message} (further errors not logged)`)
  }

  private close(entry: WatchedWorktree): void {
    entry.closed = true
    if (entry.watcher) void entry.watcher.close()
  }

  async closeAll(): Promise<void> {
    for (const entry of this.watched.values()) {
      entry.closed = true
      if (entry.watcher) await entry.watcher.close()
    }
    this.watched.clear()
  }
}

/** The directories git ignores in a worktree, or none when it is not a repository git can read. */
async function readGitIgnored(worktreePath: string): Promise<Set<string>> {
  try {
    return new Set(await ignoredDirectories(worktreePath))
  } catch {
    return new Set()
  }
}
