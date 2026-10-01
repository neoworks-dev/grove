// The agent's proposals for a worktree's conflicts and the user's decisions on
// them. Proposals live in main, where the agent's tool records them; decisions
// are the user's and live here until they are written back.

import { store, refreshDiffStats } from './store.svelte'
import { startSessionWithMessage } from './agents/newSession'
import {
  hunkKey,
  resolutionsToWrite,
  type HunkDecision
} from './conflictDecisions'
import type { ConflictHunk, ConflictProposal, ConflictedFile } from '../../../shared/types'

class ConflictReview {
  /** Proposals by worktree id. */
  proposals = $state<Record<string, ConflictProposal[]>>({})
  /** Decisions by worktree id, then by hunk key. */
  decisions = $state<Record<string, Record<string, HunkDecision>>>({})
  /** Worktrees an agent is being started for. */
  starting = $state<Record<string, boolean>>({})

  /** Re-reads a worktree's proposals from main. */
  async load(worktreeId: string): Promise<void> {
    try {
      const proposals = await window.workbench.conflicts.proposals(worktreeId)
      this.proposals = { ...this.proposals, [worktreeId]: proposals }
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Follows main's word that a worktree's proposals changed. Returns the unsubscribe. */
  watch(): () => void {
    return window.workbench.on('event:conflict-proposals', (payload) => {
      const event = payload as { worktreeId: string }
      void this.load(event.worktreeId)
    })
  }

  proposalsOf(worktreeId: string): ConflictProposal[] {
    const proposals = this.proposals[worktreeId]
    if (!proposals) return []
    return proposals
  }

  decisionsOf(worktreeId: string): Record<string, HunkDecision> {
    const decisions = this.decisions[worktreeId]
    if (!decisions) return {}
    return decisions
  }

  /** Records how one conflict is to be settled; nothing is written yet. */
  decide(
    worktreeId: string,
    path: string,
    index: number,
    hunk: ConflictHunk,
    decision: HunkDecision
  ): void {
    const next = { ...this.decisionsOf(worktreeId), [hunkKey(path, index, hunk)]: decision }
    this.decisions = { ...this.decisions, [worktreeId]: next }
  }

  /** Takes a decision back. */
  undecide(worktreeId: string, path: string, index: number, hunk: ConflictHunk): void {
    const next = { ...this.decisionsOf(worktreeId) }
    delete next[hunkKey(path, index, hunk)]
    this.decisions = { ...this.decisions, [worktreeId]: next }
  }

  /** Asks an agent, in a new session, to propose a resolution for each conflict. */
  async startAgent(worktreeId: string, worktreePath: string, paths: string[] | null): Promise<void> {
    this.starting = { ...this.starting, [worktreeId]: true }
    try {
      const prompt = await window.workbench.conflicts.agentPrompt(worktreeId, paths)
      await startSessionWithMessage(worktreePath, [{ type: 'text', text: prompt }])
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      this.starting = { ...this.starting, [worktreeId]: false }
    }
  }

  /** Writes every settled conflict back and stages the files left clean. */
  async writeAll(worktreeId: string, files: ConflictedFile[]): Promise<void> {
    const resolutions = resolutionsToWrite(
      files,
      this.proposalsOf(worktreeId),
      this.decisionsOf(worktreeId)
    )
    if (resolutions.length === 0) return
    try {
      // Built from $state proxies, which cannot cross IPC.
      await window.workbench.conflicts.write(worktreeId, $state.snapshot(resolutions))
      this.forget(worktreeId)
      void refreshDiffStats(worktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Drops the agent's proposals and the decisions made on them. */
  async discard(worktreeId: string): Promise<void> {
    this.forget(worktreeId)
    await window.workbench.conflicts.clearProposals(worktreeId).catch(() => {})
  }

  private forget(worktreeId: string): void {
    this.decisions = { ...this.decisions, [worktreeId]: {} }
    this.proposals = { ...this.proposals, [worktreeId]: [] }
  }
}

export const conflictReview = new ConflictReview()
