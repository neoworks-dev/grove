// Orchestrates worktree lifecycle: git add/remove, port-slot assignment,
// and setup command execution. Ties together git, config, ports, and state.

import { exec } from 'child_process'
import { promisify } from 'util'
import { resolve, join } from 'path'
import type { Worktree, WorkbenchConfig } from '../shared/types'
import * as git from './git'
import { assignSlots, portsForSlot } from './ports'
import { buildWorktreeEnv, substitute, spawnEnv } from './env'
import { getRepoState, updateRepoState } from './state'

const execAsync = promisify(exec)

export interface SetupLogger {
  (worktreeId: string, line: string): void
}

// Resolve the configured worktrees_dir relative to the repo root.
export function worktreesDir(repoPath: string, config: WorkbenchConfig): string {
  return resolve(repoPath, config.workbench.worktrees_dir)
}

// List worktrees and attach persisted port slots (assigning any missing ones).
export async function listWithPorts(
  repoPath: string,
  _config: WorkbenchConfig
): Promise<Worktree[]> {
  const worktrees = await git.listWorktrees(repoPath)
  const repoState = await getRepoState(repoPath)
  const slots = assignSlots(
    repoState.portSlots,
    worktrees.map((worktree) => worktree.id)
  )
  await updateRepoState(repoPath, { portSlots: slots })
  return worktrees.map((worktree) => ({ ...worktree, portSlot: slots[worktree.id] }))
}

export function portsForWorktree(config: WorkbenchConfig, slot: number): number[] {
  return portsForSlot(
    { start: config.ports.start, countPerWorktree: config.ports.count_per_worktree },
    slot
  )
}

// Run a list of shell commands sequentially in a cwd, streaming output.
async function runCommands(
  commands: string[],
  cwd: string,
  vars: Record<string, string>,
  log: (line: string) => void
): Promise<void> {
  for (const raw of commands) {
    const command = substitute(raw, vars)
    log(`$ ${command}`)
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, env: spawnEnv(vars) })
      if (stdout) log(stdout.trimEnd())
      if (stderr) log(stderr.trimEnd())
    } catch (error) {
      log(`[setup] command failed: ${(error as Error).message}`)
    }
  }
}

// Create a worktree, assign it a port slot, and run setup commands.
export async function createWorktree(
  repoPath: string,
  config: WorkbenchConfig,
  options: { name: string; baseBranch: string; newBranch?: string },
  log: SetupLogger
): Promise<Worktree> {
  const dir = worktreesDir(repoPath, config)
  const worktreePath = join(dir, options.name)

  await git.addWorktree(repoPath, worktreePath, {
    newBranch: options.newBranch,
    baseBranch: options.baseBranch
  })

  const worktrees = await listWithPorts(repoPath, config)
  const created = worktrees.find((worktree) => worktree.path === worktreePath)
  if (!created) {
    throw new Error('worktree created but not found in list')
  }

  const ports = portsForWorktree(config, created.portSlot)
  const vars = buildWorktreeEnv(created, ports)

  const repoState = await getRepoState(repoPath)
  if (!repoState.setupOnceDone && config.setup.once.length > 0) {
    await runCommands(config.setup.once, worktreePath, vars, (line) => log(created.id, line))
    await updateRepoState(repoPath, { setupOnceDone: true })
  }
  if (config.setup.per_worktree.length > 0) {
    await runCommands(config.setup.per_worktree, worktreePath, vars, (line) => log(created.id, line))
  }

  return created
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean
): Promise<void> {
  await git.removeWorktree(repoPath, worktreePath, force)
}
