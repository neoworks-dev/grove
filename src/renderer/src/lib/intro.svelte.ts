// AGENTS.md onboarding session state. Drives the intro pane: launches a
// dedicated onboarding session, tracks the protocol phase, and keeps the
// AGENTS.md showcase diff fresh after every agent edit.
//
// The phase is not pushed to us. The agent reports it through the grove-intro
// tool, which publishes it as a `ui.surface` node on the session's own
// stream — so it is read back out of the transcript the session store already
// holds.

import { store, focusAgentInPane } from './store.svelte'
import { layout } from './layout.svelte'
import { agentSessions } from './agents/sessions.svelte'
import { visiblePanels } from './agents/transcript'
import { parseUnifiedDiff, type DiffRow } from './intro/introDiff'
import {
  INTRO_KICKOFF_PROMPT,
  INTRO_PHASES,
  INTRO_SYSTEM_APPEND,
  type IntroPhase
} from './intro/prompt'

const AGENTS_FILE = 'AGENTS.md'
const EXAMPLES_DIR = '.workbench/intro'
// The surface the grove-intro extension publishes phases under.
const PHASE_SURFACE = 'grove.intro'

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
      // The onboarding protocol is what this session is for, so it is baked in
      // at creation — the harness composes the system prompt once and never again.
      const sessionId = await agentSessions.create(worktreeId, {
        title: 'Onboarding',
        appendSystemPrompt: INTRO_SYSTEM_APPEND
      })
      if (!sessionId) {
        store.setError(agentSessions.serverError || 'Could not reach the agent server.')
        return
      }
      this.chatId = sessionId
      // Onboarding writes AGENTS.md and example files as it goes; stopping to
      // approve each one is not what this flow is for.
      agentSessions.setMode(sessionId, 'acceptEdits')
      await agentSessions.open(sessionId)
      await agentSessions.send(sessionId, [
        {
          type: 'user.message',
          content: [{ type: 'text', text: INTRO_KICKOFF_PROMPT }],
          deliverAs: 'steer'
        }
      ])
      this.active = true
      await focusAgentInPane(worktreeId, sessionId)
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

  /**
   * The phase the agent has reported, read off its session's panel surfaces.
   * Falls back to whatever was last seen, so a surface cleared mid-run does not
   * rewind the stepper.
   */
  private reportedPhase(): IntroPhase | null {
    const live = agentSessions.live[this.chatId]
    if (!live) return null
    const panel = visiblePanels(live.transcript).find((item) => item.surfaceId === PHASE_SURFACE)
    if (!panel || panel.view.kind !== 'text') return null
    const phase = panel.view.text
    if (!(INTRO_PHASES as readonly string[]).includes(phase)) return null
    return phase as IntroPhase
  }

  /** Advance the stepper if the agent has moved on. Called from an effect. */
  syncPhase(): void {
    if (!this.active) return
    const reported = this.reportedPhase()
    if (reported) this.phase = reported
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
    // Hand the left dock back to the explorer when the setup pane, which hosts
    // this flow as its AGENTS.md stage, still occupies it.
    if (layout.docks.left.paneType === 'setup') {
      layout.openDock('left', 'files')
    }
  }

  async finish(discardExamples: boolean): Promise<void> {
    if (this.chatId) {
      await agentSessions.send(this.chatId, [{ type: 'user.interrupt' }]).catch(() => {})
    }
    if (discardExamples) await this.discardExamples()
    this.phase = 'done'
    await this.dismiss()
  }
}

export const intro = new IntroSession()
