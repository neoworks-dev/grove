// What a new worktree needs before anything runs in it, beyond what git checks
// out: the env files git never tracked. On unless grove.config.yaml turns it off.

import { copyFile, mkdir, access } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { listUntrackedPaths } from './git'

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

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
