// Inline agent edit: bridge the editor selection to the agent.
//  - Phase A: drop an @file:lines reference into the composer.
//  - Phase B: a floating prompt at the selection dispatches an inline edit,
//    applied under the current review mode (auto / inline / gated).
//  - Phase C (later): an in-buffer accept/reject overlay over the change.

import type { InlineHunk, AppliedRange } from '../../../shared/types'
import { store, insertIntoComposer } from './store.svelte'
import { layout } from './layout.svelte'
import { settings } from './settings.svelte'
import { activeNvimSession, nvimSessionFor } from './nvim/registry'
import { relFromRoot, selectionRef, pickAgentMode, REVIEW_MODES, type ReviewMode } from './inlineEditRef'

const MODE_SETTING = 'workbench.inlineEditMode'

type HunkStatus = 'pending' | 'accepted' | 'rejected'

// The selection an inline edit targets, captured when the prompt opens.
interface InlineSelection {
  worktreeId: string
  absPath: string
  relPath: string
  startLine: number
  endLine: number
  leafId: string
}

// A dispatched edit awaiting review, with the pre-edit snapshot so the change is
// diffed precisely (snapshot vs on-disk, not vs HEAD).
export interface PendingReview extends InlineSelection {
  snapshot: string
  review: ReviewMode
}

// An active in-buffer review: the hunks, per-hunk decision, and current output
// ranges (recomputed after each reject shifts the lines).
export interface ActiveReview extends PendingReview {
  hunks: InlineHunk[]
  status: HunkStatus[]
  ranges: AppliedRange[]
}

class InlineEdit {
  // Review mode for inline edits. Seeded from settings once they load.
  mode = $state<ReviewMode>('inline')

  // Floating-prompt session state, read by InlineEditPrompt.
  promptOpen = $state(false)
  promptLeafId = $state<string | null>(null)
  promptAnchorY = $state(0)
  // Center the prompt (selection off-screen or taller than the viewport) rather
  // than anchoring it at promptAnchorY.
  promptCentered = $state(false)
  promptRefLabel = $state('')

  private selection: InlineSelection | null = null

  // A dispatched inline edit awaiting its first disk write (fs-change begins the
  // review). Only used for the 'inline' review mode.
  pendingReview = $state<PendingReview | null>(null)

  // The active in-buffer accept/reject review, if any.
  review = $state<ActiveReview | null>(null)

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
    const placement = await session.promptPlacement(selection.startLine, selection.endLine)
    this.selection = selection
    this.promptLeafId = session.leafId
    this.promptAnchorY = placement.y
    this.promptCentered = placement.centered
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
      endLine: selection.endLine,
      leafId: session.leafId
    }
  }

  // ── Phase C: in-buffer accept/reject review ───────────────────────
  // Called from the fs-change handler. Claims a change when it is our own
  // review write (ignore) or the first write of a pending inline edit (begin the
  // review), returning true so the default diff-pane auto-open is suppressed.
  // The edit currently being diffed, so writes landing while beginReview is in
  // flight are still claimed (not handed to the diff pane).
  private beginning: { worktreeId: string; relPath: string } | null = null

  claimFsChange(worktreeId: string, relPath: string): boolean {
    const active = this.review
    if (active && active.worktreeId === worktreeId && active.relPath === relPath) return true
    if (this.beginning && this.beginning.worktreeId === worktreeId && this.beginning.relPath === relPath) {
      return true
    }
    const pending = this.pendingReview
    if (
      pending &&
      pending.review === 'inline' &&
      pending.worktreeId === worktreeId &&
      pending.relPath === relPath
    ) {
      this.pendingReview = null
      void this.beginReview(pending)
      return true
    }
    return false
  }

  private async beginReview(pending: PendingReview): Promise<void> {
    this.beginning = { worktreeId: pending.worktreeId, relPath: pending.relPath }
    try {
      const { hunks, ranges } = await window.workbench.git.beginInlineReview(
        pending.worktreeId,
        pending.relPath,
        pending.snapshot
      )
      if (hunks.length === 0) return
      this.review = { ...pending, hunks, status: hunks.map(() => 'pending'), ranges }
      this.repaint()
    } finally {
      this.beginning = null
    }
  }

  async decide(hunkIndex: number, accept: boolean): Promise<void> {
    const review = this.review
    if (!review || review.status[hunkIndex] !== 'pending') return
    review.status = review.status.map((status, index) =>
      index === hunkIndex ? (accept ? 'accepted' : 'rejected') : status
    )
    await this.applyDecisions(review, !accept)
  }

  async resolveAll(accept: boolean): Promise<void> {
    const review = this.review
    if (!review) return
    let rejected = false
    review.status = review.status.map((status) => {
      if (status !== 'pending') return status
      if (!accept) rejected = true
      return accept ? 'accepted' : 'rejected'
    })
    await this.applyDecisions(review, rejected)
  }

  // Rewrite the file to reflect the current decisions, reload the buffer when a
  // reject changed it, then repaint or finish.
  private async applyDecisions(review: ActiveReview, reloadBuffer: boolean): Promise<void> {
    const applied = review.status.map((status) => status !== 'rejected')
    try {
      review.ranges = await window.workbench.git.applyInlineReview(
        review.worktreeId,
        review.relPath,
        review.snapshot,
        review.hunks,
        applied
      )
    } catch (err) {
      store.setError((err as Error).message)
      return
    }
    if (reloadBuffer) await nvimSessionFor(review.leafId)?.reloadBuffer()
    if (review.status.every((status) => status !== 'pending')) {
      this.finishReview()
      return
    }
    this.repaint()
  }

  private repaint(): void {
    const review = this.review
    if (!review) return
    const session = nvimSessionFor(review.leafId)
    if (!session) return
    const pending = review.ranges.filter((range) => review.status[range.hunkIndex] === 'pending')
    void session.paintInlineReview(pending.map((range) => ({ start: range.start, count: range.count })))
  }

  private finishReview(): void {
    const review = this.review
    this.review = null
    if (review) void nvimSessionFor(review.leafId)?.clearInlineReview()
  }
}

export const inlineEdit = new InlineEdit()
