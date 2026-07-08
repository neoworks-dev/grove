// Per-worktree environment variables and ${VAR} substitution.
// Reused for service commands, agent commands, preview URLs, and health URLs.

import type { Worktree } from '../shared/types'

// Build the WT_* and PORT_n variables for a worktree.
export function buildWorktreeEnv(worktree: Worktree, ports: number[]): Record<string, string> {
  const env: Record<string, string> = {
    WT_ID: worktree.id,
    WT_NAME: worktree.name,
    WT_PATH: worktree.path,
    WT_BRANCH: worktree.branch
  }
  ports.forEach((port, index) => {
    env[`PORT_${index}`] = String(port)
  })
  return env
}

// Replace ${VAR} and $VAR occurrences using the provided variable map.
// Unknown variables are left untouched so real shell vars still resolve at runtime.
export function substitute(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (match, braced, bare) => {
    const name = braced || bare
    if (vars[name] !== undefined) {
      return vars[name]
    }
    return match
  })
}

// Merge worktree vars over the current process env for spawning children.
export function spawnEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...vars }
}
