// Executes keybind actions (command / shell / ai-prompt). Project-scope
// shell and AI actions are repo-supplied code execution, so they require a
// one-time trust confirmation; the approval hash persists in repo state.

import type { KeybindAction } from '../../../shared/actions'
import { commands } from './commands.svelte'
import { dialogs } from './dialogs.svelte'
import { store } from './store.svelte'
import { settings } from './settings.svelte'
import { layout } from './layout.svelte'
import { agentPrompt } from './agentPrompt.svelte'
import { actionHash } from './bindingResolution'

export async function executeAction(action: KeybindAction, fromProjectScope: boolean): Promise<void> {
  if (action.type === 'command') {
    runCommand(action.commandId)
    return
  }
  if (fromProjectScope && !(await confirmProjectAction(action))) return
  if (action.type === 'shell') {
    await runShell(action.commandLine)
    return
  }
  await runAiPrompt(action.prompt, action.autoSend, action.agent)
}

function runCommand(commandId: string): void {
  const command = commands.commands.find((entry) => entry.id === commandId)
  if (!command) {
    dialogs.notify({ level: 'error', message: `Unknown command "${commandId}"` })
    return
  }
  void command.run()
}

async function runShell(commandLine: string): Promise<void> {
  const worktreeId = store.selectedWorktreeId
  if (!worktreeId) {
    dialogs.notify({ level: 'warn', message: 'No worktree selected for shell command' })
    return
  }
  try {
    await window.workbench.actions.runShell(worktreeId, commandLine)
  } catch (error) {
    dialogs.notify({ level: 'error', message: (error as Error).message })
  }
}

async function runAiPrompt(prompt: string, autoSend: boolean, agent?: string): Promise<void> {
  if (!autoSend) {
    agentPrompt.request(prompt)
    focusAgentPane()
    return
  }
  const worktreeId = store.selectedWorktreeId
  if (!worktreeId) {
    dialogs.notify({ level: 'warn', message: 'No worktree selected for AI prompt' })
    return
  }
  const agentName = agent || settings.get<string>('workbench.defaultAgent')
  if (!agentName) {
    dialogs.notify({ level: 'warn', message: 'No agent configured for AI prompt actions' })
    return
  }
  try {
    await window.workbench.agents.start(worktreeId, agentName, { prompt })
  } catch (error) {
    dialogs.notify({ level: 'error', message: (error as Error).message })
  }
}

function focusAgentPane(): void {
  layout.ensurePane('agent')
}

function describeAction(action: KeybindAction): string {
  if (action.type === 'shell') return action.commandLine
  if (action.type === 'ai-prompt') return action.prompt
  return action.commandId
}

// One-time consent for repo-supplied executable actions; "always" persists a
// hash of the action into repo state.
async function confirmProjectAction(action: KeybindAction): Promise<boolean> {
  const hash = actionHash(`${action.type}:${describeAction(action)}`)
  const repoState = await window.workbench.state.getRepo()
  const trusted = repoState.trustedActionHashes ?? []
  if (trusted.includes(hash)) return true
  const kindLabel = action.type === 'shell' ? 'shell command' : 'AI prompt'
  const choice = await dialogs.confirm({
    title: 'Run project-defined action?',
    body: `This repository's settings define a ${kindLabel} keybinding. Run it?`,
    detail: describeAction(action),
    actions: [
      { id: 'always', label: 'Always allow', kind: 'primary' },
      { id: 'once', label: 'Run once' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice === 'always') {
    await window.workbench.state.update({ trustedActionHashes: [...trusted, hash] })
    return true
  }
  return choice === 'once'
}
