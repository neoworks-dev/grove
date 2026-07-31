// Pure stage sequencing for the first-run setup wizard.
//
// Split out of setup.svelte.ts so the branching — which stages a repo still
// needs, and what follows the current one — is testable without a rune context.

export const SETUP_STAGES = ['config', 'agents-md', 'done'] as const
export type SetupStage = (typeof SETUP_STAGES)[number]

export const SETUP_STAGE_LABELS: Record<SetupStage, string> = {
  config: 'Services',
  'agents-md': 'AGENTS.md',
  done: 'Done'
}

export interface RepoSetupNeeds {
  hasConfig: boolean
  hasAgentsFile: boolean
}

// The stages this repo still needs, in order. Finished work is left out so a
// repo that already has a workbench.yaml is not walked through it again.
export function pendingStages(needs: RepoSetupNeeds): SetupStage[] {
  const stages: SetupStage[] = []
  if (!needs.hasConfig) stages.push('config')
  if (!needs.hasAgentsFile) stages.push('agents-md')
  return stages
}

// The stage after `current`, or null when the flow is finished. Returns the
// first pending stage when `current` is not in the list, so a stale stage left
// over from a previous repo cannot strand the wizard.
export function nextStage(current: SetupStage, stages: SetupStage[]): SetupStage | null {
  if (stages.length === 0) return null

  const index = stages.indexOf(current)
  if (index === -1) return stages[0]

  const next = stages[index + 1]
  if (!next) return null
  return next
}
