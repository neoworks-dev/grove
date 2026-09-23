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
import { copyEnvFiles, installCommand } from './worktreeBootstrap'

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
  options: { name: string; baseBranch?: string; newBranch?: string; checkoutBranch?: string },
  log: SetupLogger
): Promise<Worktree> {
  const dir = worktreesDir(repoPath, config)
  const worktreePath = join(dir, options.name)

  await git.addWorktree(repoPath, worktreePath, {
    newBranch: options.newBranch,
    baseBranch: options.baseBranch,
    checkoutBranch: options.checkoutBranch
  })

  const worktrees = await listWithPorts(repoPath, config)
  const created = worktrees.find((worktree) => worktree.path === worktreePath)
  if (!created) {
    throw new Error('worktree created but not found in list')
  }

  const ports = portsForWorktree(config, created.portSlot)
  const vars = buildWorktreeEnv(created, ports)
  const logLine = (line: string): void => log(created.id, line)

  await bootstrapWorktree(
    mainWorktreePath(repoPath, worktrees),
    worktreePath,
    config,
    vars,
    logLine
  )

  const repoState = await getRepoState(repoPath)
  if (!repoState.setupOnceDone && config.setup.once.length > 0) {
    await runCommands(config.setup.once, worktreePath, vars, (line) => log(created.id, line))
    await updateRepoState(repoPath, { setupOnceDone: true })
  }
  if (config.setup.per_worktree.length > 0) {
    await runCommands(config.setup.per_worktree, worktreePath, vars, (line) =>
      log(created.id, line)
    )
  }

  return created
}

/** The main worktree's path, where untracked files like `.env` live. */
function mainWorktreePath(repoPath: string, worktrees: Worktree[]): string {
  const main = worktrees.find((worktree) => worktree.isMain)
  if (!main) return repoPath
  return main.path
}

/**
 * Gives a new worktree what git does not: the main worktree's untracked env
 * files and installed dependencies, each unless workbench.yaml turns it off.
 * Runs before the setup commands, which may well need both.
 */
async function bootstrapWorktree(
  mainPath: string,
  worktreePath: string,
  config: WorkbenchConfig,
  vars: Record<string, string>,
  log: (line: string) => void
): Promise<void> {
  if (config.setup.copy_env) {
    await copyEnvFiles(mainPath, worktreePath, log).catch((error: Error) =>
      log(`[setup] copying env files failed: ${error.message}`)
    )
  }
  if (!config.setup.install) return
  const command = await installCommand(worktreePath, config.setup.per_worktree)
  if (!command) return
  await runCommands([command], worktreePath, vars, log)
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean
): Promise<void> {
  await git.removeWorktree(repoPath, worktreePath, force)
}

// Archive a finished worktree: remove the worktree directory and, when
// requested, delete its (now-merged) branch. Service teardown is handled by the
// IPC caller, mirroring removeWorktree.
export async function archiveWorktree(
  repoPath: string,
  worktreePath: string,
  options: { branch?: string; deleteBranch: boolean; force: boolean }
): Promise<void> {
  await git.removeWorktree(repoPath, worktreePath, options.force)
  if (options.deleteBranch && options.branch) {
    await git.deleteBranch(repoPath, options.branch, options.force)
  }
}
