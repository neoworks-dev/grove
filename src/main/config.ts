// Repo-root YAML config: load, validate, apply defaults, write a sample.

import { load, dump } from 'js-yaml'
import { readFile, writeFile, access } from 'fs/promises'
import { join } from 'path'
import type { WorkbenchConfig } from '../shared/types'

export const CONFIG_FILENAME = 'workbench.yaml'

const DEFAULT_CONFIG: WorkbenchConfig = {
  workbench: {
    worktrees_dir: '../.worktrees',
    default_base_branch: 'main'
  },
  ports: {
    start: 3100,
    count_per_worktree: 10
  },
  setup: {
    once: [],
    per_worktree: []
  },
  services: {},
  agents: {}
}

export function configPath(repoPath: string): string {
  return join(repoPath, CONFIG_FILENAME)
}

// Merge a parsed object over defaults so every field is present for consumers.
export function applyDefaults(raw: unknown): WorkbenchConfig {
  const input = (raw || {}) as Partial<WorkbenchConfig>
  return {
    workbench: {
      worktrees_dir: input.workbench?.worktrees_dir ?? DEFAULT_CONFIG.workbench.worktrees_dir,
      default_base_branch:
        input.workbench?.default_base_branch ?? DEFAULT_CONFIG.workbench.default_base_branch
    },
    ports: {
      start: input.ports?.start ?? DEFAULT_CONFIG.ports.start,
      count_per_worktree: input.ports?.count_per_worktree ?? DEFAULT_CONFIG.ports.count_per_worktree
    },
    setup: {
      once: input.setup?.once ?? [],
      per_worktree: input.setup?.per_worktree ?? []
    },
    services: input.services ?? {},
    agents: input.agents ?? {}
  }
}

export async function loadConfig(repoPath: string): Promise<WorkbenchConfig> {
  const path = configPath(repoPath)
  try {
    const text = await readFile(path, 'utf8')
    const parsed = load(text)
    return applyDefaults(parsed)
  } catch {
    // No config yet — return defaults so the app still functions.
    return applyDefaults({})
  }
}

export async function configExists(repoPath: string): Promise<boolean> {
  try {
    await access(configPath(repoPath))
    return true
  } catch {
    return false
  }
}

const SAMPLE_CONFIG = `workbench:
  worktrees_dir: ../.worktrees
  default_base_branch: main

ports:
  start: 3100
  count_per_worktree: 10

setup:
  once:
    - echo "setup once"
  per_worktree:
    - echo "setup per worktree"

services:
  web:
    command: python3 -m http.server \${PORT_0}
    preview: http://localhost:\${PORT_0}
    health: http://localhost:\${PORT_0}
    log: web.log

agents:
  claude:
    command: claude -p
  codex:
    command: codex exec
  opencode:
    command: opencode -?
`

// Write a starter config only if none exists. Returns true when written.
export async function writeSampleConfig(repoPath: string): Promise<boolean> {
  if (await configExists(repoPath)) return false
  await writeFile(configPath(repoPath), SAMPLE_CONFIG, 'utf8')
  return true
}

export async function saveConfig(repoPath: string, config: WorkbenchConfig): Promise<void> {
  await writeFile(configPath(repoPath), dump(config), 'utf8')
}
