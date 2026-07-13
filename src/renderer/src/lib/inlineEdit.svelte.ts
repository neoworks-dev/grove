// Inline agent edit: bridge the editor selection to the agent.
//  - Phase A: drop an @file:lines reference into the composer.
//  - Phase B: a floating prompt at the selection dispatches an inline edit,
//    applied under the current review mode (auto / inline / gated).
//  - Phase C (later): an in-buffer accept/reject overlay over the change.

import { store, insertIntoComposer } from './store.svelte'
import { layout } from './layout.svelte'
import { settings } from './settings.svelte'
import { activeNvimSession, nvimSessionFor } from './nvim/registry'
import { relFromRoot, selectionRef, pickAgentMode, REVIEW_MODES, type ReviewMode } from './inlineEditRef'

const MODE_SETTING = 'workbench.inlineEditMode'

// The selection an inline edit targets, captured when the prompt opens.
interface InlineSelection {
  worktreeId: string
  absPath: string
  relPath: string
  startLine: number
  endLine: number
}

// A dispatched edit awaiting review, with the pre-edit snapshot so Phase C can
// diff the agent's change precisely (snapshot vs on-disk, not vs HEAD).
export interface PendingReview extends InlineSelection {
  snapshot: string
  review: ReviewMode
}

class InlineEdit {
  // Review mode for inline edits. Seeded from settings once they load.
  mode = $state<ReviewMode>('inline')

  // Floating-prompt session state, read by InlineEditPrompt.
  promptOpen = $state(false)
  promptLeafId = $state<string | null>(null)
  promptAnchorY = $state(0)
  promptRefLabel = $state('')

  private selection: InlineSelection | null = null

  // The most recent dispatched-but-unreviewed edit (consumed by Phase C).
  pendingReview = $state<PendingReview | null>(null)

  private modeLoaded = false

  private ensureModeLoaded(): void {
    if (this.modeLoaded) return
    this.modeLoaded = true
    const saved = settings.get<string>(MODE_SETTING)
    if (saved && (REVIEW_MODES as string[]).includes(saved)) {
      this.mode = saved as ReviewMode
    }
  }

  setMode(mode: ReviewMode): void {
    this.mode = mode
    void settings.set(MODE_SETTING, mode, 'user')
  }

  cycleMode(): ReviewMode {
    this.ensureModeLoaded()
    const next = REVIEW_MODES[(REVIEW_MODES.indexOf(this.mode) + 1) % REVIEW_MODES.length]
    this.setMode(next)
    return next
  }

  // ── Phase A: send the selection to the composer as an @-reference ──
  async sendSelectionToComposer(): Promise<void> {
    const selection = await this.readSelection()
    if (!selection) return
    const ref = selectionRef(selection.relPath, selection.startLine, selection.endLine)
    layout.ensurePane('agent')
    insertIntoComposer(ref)
  }

  // ── Phase B: floating inline-edit prompt ──────────────────────────
  async openPrompt(): Promise<void> {
    this.ensureModeLoaded()
    const session = activeNvimSession()
    if (!session) return
    const selection = await this.readSelectionFrom(session)
    if (!selection) return
    const anchorY = await session.screenYForLine(selection.startLine)
    this.selection = selection
    this.promptLeafId = session.leafId
    this.promptAnchorY = anchorY ?? 0
    this.promptRefLabel = selectionRef(selection.relPath, selection.startLine, selection.endLine)
    this.promptOpen = true
  }

  cancelPrompt(): void {
    const leafId = this.promptLeafId
    this.promptOpen = false
    this.selection = null
    if (leafId) nvimSessionFor(leafId)?.focus()
  }

  async submitPrompt(userPrompt: string): Promise<void> {
    const selection = this.selection
    const leafId = this.promptLeafId
    this.promptOpen = false
    this.selection = null
    if (leafId) nvimSessionFor(leafId)?.focus()
    if (!selection) return
    await this.dispatch(selection, userPrompt)
  }

  // ── Dispatch ──────────────────────────────────────────────────────
  private async dispatch(selection: InlineSelection, userPrompt: string): Promise<void> {
    const agent = this.currentAgent()
    if (!agent) {
      store.setError('No agent configured to run the inline edit.')
      return
    }
    let snapshot = ''
    try {
      snapshot = await window.workbench.files.read(selection.worktreeId, selection.absPath)
    } catch {
      // Unreadable snapshot only disables Phase C's precise diff, not the edit.
    }
    const ref = selectionRef(selection.relPath, selection.startLine, selection.endLine)
    const text = `Make this edit in @${ref}: ${userPrompt}`
    const mode = pickAgentMode(store.agentConfigs[agent]?.modes || [], this.mode)
    this.pendingReview = { ...selection, snapshot, review: this.mode }
    try {
      if (store.activeAgentWorktrees.includes(selection.worktreeId)) {
        await window.workbench.agents.send(selection.worktreeId, agent, text)
      } else {
        await window.workbench.agents.start(selection.worktreeId, agent, { prompt: text, mode })
      }
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  private currentAgent(): string | null {
    const saved = settings.get<string>('workbench.defaultAgent')
    if (saved && store.agentConfigs[saved]) return saved
    const names = Object.keys(store.agentConfigs)
    return names[0] ?? null
  }

  // ── Selection helpers ─────────────────────────────────────────────
  private async readSelection(): Promise<InlineSelection | null> {
    const session = activeNvimSession()
    if (!session) return null
    return this.readSelectionFrom(session)
  }

  private async readSelectionFrom(
    session: NonNullable<ReturnType<typeof activeNvimSession>>
  ): Promise<InlineSelection | null> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return null
    const selection = await session.getVisualSelection()
    if (!selection || !selection.path) return null
    return {
      worktreeId,
      absPath: selection.path,
      relPath: relFromRoot(store.selectedWorktree?.path, selection.path),
      startLine: selection.startLine,
      endLine: selection.endLine
    }
  }
}

export const inlineEdit = new InlineEdit()
