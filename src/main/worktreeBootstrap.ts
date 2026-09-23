// What a new worktree needs before anything runs in it, beyond what git checks
// out: the env files git never tracked, and installed dependencies. Both are on
// unless workbench.yaml turns them off.

import { copyFile, mkdir, readdir, access } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { listUntrackedPaths } from './git'
import { managerForLockfiles } from './detect/packageManagers'

/** Whether a path names an env file: `.env`, or `.env.<anything>`. */
export function isEnvFile(path: string): boolean {
  const name = basename(path)
  return name === '.env' || name.startsWith('.env.')
}

/** The untracked env files in a worktree, relative to it — ignored or not. */
export async function untrackedEnvFiles(worktreePath: string): Promise<string[]> {
  const paths = await listUntrackedPaths(worktreePath)
  return paths.filter(isEnvFile)
}

/**
 * Copies the main worktree's untracked env files into a new worktree at the same
 * relative paths, leaving any the new worktree already has alone.
 */
export async function copyEnvFiles(
  mainPath: string,
  worktreePath: string,
  log: (line: string) => void
): Promise<void> {
  const files = await untrackedEnvFiles(mainPath).catch(() => [])
  for (const file of files) {
    const target = join(worktreePath, file)
    if (await exists(target)) continue
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(mainPath, file), target)
    log(`[setup] copied ${file} from the main worktree`)
  }
}

/**
 * The command that installs a worktree's dependencies, or null when there is
 * nothing to install or no lockfile says how. Skipped too when `per_worktree`
 * already runs that install, so it does not run twice.
 */
export async function installCommand(
  worktreePath: string,
  perWorktree: readonly string[]
): Promise<string | null> {
  const fileNames = await readdir(worktreePath).catch((): string[] => [])
  if (!fileNames.includes('package.json')) return null
  const manager = managerForLockfiles(fileNames)
  if (!manager) return null
  const command = `${manager} install`
  if (perWorktree.some((configured) => configured.trim().startsWith(command))) return null
  return command
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
