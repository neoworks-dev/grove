// Which package manager a JavaScript project uses, read off its lockfile, so
// worktree setup installs dependencies with the right one.

/** A lockfile and the package manager that writes it. */
export interface LockfileManager {
  file: string
  manager: 'bun' | 'pnpm' | 'yarn' | 'npm'
}

// Order matters: a repo with both a bun lockfile and a package-lock is treated
// as bun.
export const LOCKFILE_MANAGERS: readonly LockfileManager[] = [
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' }
]

/** The package manager whose lockfile is among the given file names, or null for none. */
export function managerForLockfiles(
  fileNames: readonly string[]
): LockfileManager['manager'] | null {
  for (const candidate of LOCKFILE_MANAGERS) {
    if (fileNames.includes(candidate.file)) return candidate.manager
  }
  return null
}
