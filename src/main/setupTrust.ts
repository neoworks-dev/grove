// Consent for grove.config.yaml's setup commands. The file is checked into the
// repo, so its commands are whatever the repo's author wrote: nothing runs until
// the user has seen them, and a change to them asks again.

import { createHash } from 'crypto'
import { dialog } from 'electron'
import type { WorkbenchConfig } from '../shared/types'
import { getRepoState, updateRepoState } from './state'

/** Shows setup commands to the user and resolves to whether they may run. */
export type AskToTrustSetup = (commands: string[]) => Promise<boolean>

/** Every setup command the config can run, `once` before `per_worktree`. */
export function setupCommands(config: WorkbenchConfig): string[] {
  return [...config.setup.once, ...config.setup.per_worktree]
}

/** A stable fingerprint of the setup commands, so trust lapses when they change. */
export function setupFingerprint(config: WorkbenchConfig): string {
  const text = JSON.stringify({ once: config.setup.once, perWorktree: config.setup.per_worktree })
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Resolves to whether the repo's setup commands may run: yes when these exact
 * commands were trusted before, otherwise whatever the user answers — and a yes
 * is remembered until the commands change.
 */
export async function ensureSetupTrusted(
  repoPath: string,
  config: WorkbenchConfig,
  ask: AskToTrustSetup
): Promise<boolean> {
  const fingerprint = setupFingerprint(config)
  const repoState = await getRepoState(repoPath)
  if (repoState.trustedSetupHash === fingerprint) {
    return true
  }
  const trusted = await ask(setupCommands(config))
  if (!trusted) {
    return false
  }
  await updateRepoState(repoPath, { trustedSetupHash: fingerprint })
  return true
}

/** Asks through a native dialog, listing the commands exactly as they will run. */
export async function askToTrustSetupNatively(commands: string[]): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Run setup commands?',
    message: "This repository's grove.config.yaml runs these commands when a worktree is created:",
    detail: commands.join('\n'),
    buttons: ["Don't run", 'Trust and run'],
    defaultId: 0,
    cancelId: 0
  })
  return result.response === 1
}
