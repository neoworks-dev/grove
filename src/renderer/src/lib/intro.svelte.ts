// AGENTS.md onboarding session state. Drives the intro pane: launches the
// dedicated "Onboarding" claude instance, tracks the protocol phase, and keeps
// the AGENTS.md showcase diff fresh after every agent edit.

import { store, focusAgentInPane } from './store.svelte'
import { layout } from './layout.svelte'
import { parseUnifiedDiff, type DiffRow } from './intro/introDiff'
import {
  INTRO_KICKOFF_PROMPT,
  INTRO_PHASES,
  INTRO_SYSTEM_APPEND,
  type IntroPhase
} from './intro/prompt'

const AGENTS_FILE = 'AGENTS.md'
const EXAMPLES_DIR = '.workbench/intro'
const AGENT_NAME = 'claude'

class IntroSession {
  active = $state(false)
  phase = $state<IntroPhase>('explore')
  worktreeId = $state<string | null>(null)
  chatId = $state('')
  // AGENTS.md content at session start ('' when the file doesn't exist yet).
  baseline = $state('')
  // Diff base for the showcase card; advanced by markReviewed().
  lastShowcased = $state('')
  // Show the diff against the session baseline instead of the last showcase.
  showSinceStart = $state(false)
  diffRows = $state<DiffRow[]>([])
  exampleFiles = $state<string[]>([])
  starting = $state(false)

  private worktreePath(): string | null {
    const worktree = store.worktrees.find((entry) => entry.id === this.worktreeId)
    if (worktree) return worktree.path
    return null
  }

  private agentsFilePath(): string | null {
    const root = this.worktreePath()
    if (root) return `${root}/${AGENTS_FILE}`
    return null
  }

  private async readAgentsFile(): Promise<string> {
    const path = this.agentsFilePath()
    if (!this.worktreeId || !path) return ''
    try {
      return await window.workbench.files.read(this.worktreeId, path)
    } catch {
      return ''
    }
  }

  async start(worktreeId: string): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      this.worktreeId = worktreeId
      this.baseline = await this.readAgentsFile()
      this.lastShowcased = this.baseline
      this.diffRows = []
      this.exampleFiles = []
      this.phase = 'explore'
      const chat = await window.workbench.agents.createInstance(worktreeId, AGENT_NAME, 'Onboarding')
      this.chatId = chat.id
      await window.workbench.agents.start(
        worktreeId,
        AGENT_NAME,
        {
          prompt: INTRO_KICKOFF_PROMPT,
          mode: 'acceptEdits',
          appendSystemPrompt: INTRO_SYSTEM_APPEND,
          intro: true
        },
        chat.id
      )
      this.active = true
      await focusAgentInPane(worktreeId, AGENT_NAME, chat.id)
    } finally {
      this.starting = false
    }
  }

  // Route AGENTS.md and example-file changes to the intro pane instead of the
  // git-changes sidebar while a session runs. Returns true when claimed.
  claimFsChange(worktreeId: string, relPath: string): boolean {
    if (!this.active || worktreeId !== this.worktreeId) return false
    if (relPath === AGENTS_FILE) {
      void this.refreshDiff()
      return true
    }
    if (relPath.startsWith(`${EXAMPLES_DIR}/`)) {
      if (!this.exampleFiles.includes(relPath)) {
        this.exampleFiles = [...this.exampleFiles, relPath]
      }
      return true
    }
    return false
  }

  async refreshDiff(): Promise<void> {
    if (!this.worktreeId) return
    const current = await this.readAgentsFile()
    let base = this.lastShowcased
    if (this.showSinceStart) base = this.baseline
    const diffText = await window.workbench.git.diffText(this.worktreeId, base, current)
    this.diffRows = parseUnifiedDiff(diffText)
  }

  async toggleSinceStart(): Promise<void> {
    this.showSinceStart = !this.showSinceStart
    await this.refreshDiff()
  }

  async markReviewed(): Promise<void> {
    this.lastShowcased = await this.readAgentsFile()
    this.showSinceStart = false
    this.diffRows = []
  }

  setPhase(worktreeId: string, chatId: string, phase: string): void {
    if (!this.active) return
    if (worktreeId !== this.worktreeId || chatId !== this.chatId) return
    if ((INTRO_PHASES as readonly string[]).includes(phase)) {
      this.phase = phase as IntroPhase
    }
  }

  async discardExamples(): Promise<void> {
    if (!this.worktreeId) return
    await window.workbench.files.delete(this.worktreeId, EXAMPLES_DIR).catch(() => {})
    this.exampleFiles = []
  }

  // Persist dismissal and leave the intro page. Used by "Not now" and finish().
  async dismiss(): Promise<void> {
    await window.workbench.state.update({ introDismissed: true })
    this.active = false
    layout.showCenterPane('dashboard')
  }

  async finish(discardExamples: boolean): Promise<void> {
    if (this.worktreeId && this.chatId) {
      await window.workbench.agents.stop(this.worktreeId, AGENT_NAME, this.chatId).catch(() => {})
    }
    if (discardExamples) await this.discardExamples()
    this.phase = 'done'
    await this.dismiss()
  }
}

export const intro = new IntroSession()
