// First-run setup state. Drives the setup pane through the stages a fresh repo
// needs before Grove is useful: workbench.yaml, a default agent, then AGENTS.md.
//
// The AGENTS.md stage is not reimplemented here — it delegates to the existing
// intro session, which owns the agent run and the showcase diff. This store only
// decides which stage is showing and owns the config stage's own state.

import { store } from './store.svelte'
import { layout } from './layout.svelte'
import { settings } from './settings.svelte'
import type { ServiceProposal, ServiceConfig } from '../../../shared/types'
import { pendingStages, nextStage, type SetupStage } from './setup/stages'

export { SETUP_STAGES, SETUP_STAGE_LABELS, type SetupStage } from './setup/stages'

class SetupSession {
  stage = $state<SetupStage>('config')
  // Proposals from the detectors, plus which ones the user wants written.
  proposals = $state<ServiceProposal[]>([])
  selected = $state<Set<string>>(new Set())
  detecting = $state(false)
  writing = $state(false)
  // Set when detection ran and found nothing, so the pane can offer the agent
  // fallback instead of an empty list that looks like a failure.
  detectedNothing = $state(false)
  error = $state<string | null>(null)

  // Stages this repo still needs. A repo with a workbench.yaml but no AGENTS.md
  // starts partway through rather than being walked past finished work.
  get pendingStages(): SetupStage[] {
    return pendingStages({
      hasConfig: Boolean(store.repo?.hasConfig),
      hasAgentsFile: Boolean(store.repo?.hasAgentsFile)
    })
  }

  async begin(): Promise<void> {
    const first = this.pendingStages[0]
    if (!first) {
      await this.dismiss()
      return
    }
    this.stage = first
    if (first === 'config') await this.detect()
  }

  async detect(): Promise<void> {
    if (this.detecting) return
    this.detecting = true
    this.error = null
    try {
      const found = await window.workbench.config.detect()
      this.proposals = found
      // Everything detected is pre-selected: the common case is "yes, those are
      // my services", and unchecking is cheaper than checking each one.
      this.selected = new Set(found.map((proposal) => proposal.name))
      this.detectedNothing = found.length === 0
    } catch (error) {
      this.error = errorMessage(error)
    } finally {
      this.detecting = false
    }
  }

  toggle(name: string): void {
    const next = new Set(this.selected)
    if (next.has(name)) {
      next.delete(name)
    } else {
      next.add(name)
    }
    this.selected = next
  }

  // Edits from the pane. Proposals are replaced rather than mutated so the
  // rune-backed array notifies.
  update(name: string, patch: Partial<ServiceProposal>): void {
    this.proposals = this.proposals.map((proposal) => {
      if (proposal.name !== name) return proposal
      return { ...proposal, ...patch }
    })
  }

  async writeConfig(): Promise<void> {
    if (this.writing) return
    this.writing = true
    this.error = null
    try {
      await window.workbench.config.writeServices(this.selectedServices())
      store.config = await window.workbench.config.load()
      if (store.repo) store.repo = { ...store.repo, hasConfig: true }
      this.advance()
    } catch (error) {
      this.error = errorMessage(error)
    } finally {
      this.writing = false
    }
  }

  private selectedServices(): Record<string, ServiceConfig> {
    const services: Record<string, ServiceConfig> = {}
    for (const proposal of this.proposals) {
      if (!this.selected.has(proposal.name)) continue
      services[proposal.name] = toServiceConfig(proposal)
    }
    return services
  }

  async chooseAgent(name: string): Promise<void> {
    await settings.set('workbench.defaultAgent', name, 'user')
    this.advance()
  }

  // Move to the next stage this repo still needs, finishing when none are left.
  advance(): void {
    const next = nextStage(this.stage, this.pendingStages)
    if (!next) {
      void this.dismiss()
      return
    }
    this.stage = next
  }

  skip(): void {
    this.advance()
  }

  // Persist dismissal and hand the dock back. Mirrors intro.dismiss(), which
  // stays responsible for its own flag so a repo that only finished AGENTS.md
  // is still offered the config stage later.
  async dismiss(): Promise<void> {
    this.stage = 'done'
    await window.workbench.state.update({ setupDismissed: true })
    if (layout.docks.left.paneType === 'setup') {
      layout.openDock('left', 'files')
    }
  }
}

function toServiceConfig(proposal: ServiceProposal): ServiceConfig {
  const service: ServiceConfig = { command: proposal.command }
  if (proposal.preview) service.preview = proposal.preview
  if (proposal.health) service.health = proposal.health
  return service
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const setup = new SetupSession()
