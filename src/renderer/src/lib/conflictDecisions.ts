// Settling conflicts an agent proposed resolutions for: what each decision
// writes, which conflicts are still open, and what goes back to main.

import type {
  ConflictChoice,
  ConflictHunk,
  ConflictProposal,
  ConflictResolutionLines,
  ConflictedFile
} from '../../../shared/types'

/** How one conflict was settled: the agent's proposal, an edit of it, or a side. */
export type DecisionKind = 'proposal' | 'edited' | ConflictChoice

export interface HunkDecision {
  kind: DecisionKind
  lines: string[]
}

/**
 * Names one conflict as it is now. A conflict that changes (resolved by hand,
 * the merge restarted) gets a new key, so an old decision cannot apply to it.
 */
export function hunkKey(path: string, index: number, hunk: ConflictHunk): string {
  return `${path}#${index}#${textHash([...hunk.ours, '\u0000', ...hunk.theirs].join('\n'))}`
}

/** A short, stable hash of some text; only to tell two conflicts apart. */
function textHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** The lines taking one side (or both, ours first) writes. */
export function sideLines(hunk: ConflictHunk, choice: ConflictChoice): string[] {
  if (choice === 'ours') return hunk.ours
  if (choice === 'theirs') return hunk.theirs
  return [...hunk.ours, ...hunk.theirs]
}

/** The agent's proposal for a conflict, if it made one. */
export function proposalFor(
  proposals: readonly ConflictProposal[],
  path: string,
  index: number
): ConflictProposal | null {
  const found = proposals.find((proposal) => proposal.path === path && proposal.hunkIndex === index)
  if (!found) return null
  return found
}

/** Files the agent proposed anything for: their conflicts are settled, not written one by one. */
export function reviewedFiles(
  files: readonly ConflictedFile[],
  proposals: readonly ConflictProposal[]
): ConflictedFile[] {
  return files.filter((file) => proposals.some((proposal) => proposal.path === file.path))
}

/** Every conflict in the reviewed files, each with its decision if it has one. */
function reviewedHunks(
  files: readonly ConflictedFile[],
  proposals: readonly ConflictProposal[],
  decisions: Record<string, HunkDecision>
): { path: string; index: number; decision: HunkDecision | undefined }[] {
  return reviewedFiles(files, proposals).flatMap((file) =>
    file.hunks.map((hunk, index) => ({
      path: file.path,
      index,
      decision: decisions[hunkKey(file.path, index, hunk)]
    }))
  )
}

/** How many conflicts under review are settled, of how many. */
export function settledCount(
  files: readonly ConflictedFile[],
  proposals: readonly ConflictProposal[],
  decisions: Record<string, HunkDecision>
): { settled: number; total: number } {
  const hunks = reviewedHunks(files, proposals, decisions)
  const settled = hunks.filter((entry) => entry.decision !== undefined).length
  return { settled, total: hunks.length }
}

/** What to write back: every reviewed conflict's decided lines. */
export function resolutionsToWrite(
  files: readonly ConflictedFile[],
  proposals: readonly ConflictProposal[],
  decisions: Record<string, HunkDecision>
): ConflictResolutionLines[] {
  const resolutions: ConflictResolutionLines[] = []
  for (const entry of reviewedHunks(files, proposals, decisions)) {
    if (!entry.decision) continue
    resolutions.push({ path: entry.path, hunkIndex: entry.index, lines: entry.decision.lines })
  }
  return resolutions
}

/**
 * One file as grove would write it for a preview: each conflict's decision,
 * else the agent's proposal, else left as it is.
 */
export function previewResolutions(
  file: ConflictedFile,
  proposals: readonly ConflictProposal[],
  decisions: Record<string, HunkDecision>
): ConflictResolutionLines[] {
  const resolutions: ConflictResolutionLines[] = []
  file.hunks.forEach((hunk, index) => {
    const decision = decisions[hunkKey(file.path, index, hunk)]
    if (decision) {
      resolutions.push({ path: file.path, hunkIndex: index, lines: decision.lines })
      return
    }
    const proposal = proposalFor(proposals, file.path, index)
    if (proposal && proposal.lines) {
      resolutions.push({ path: file.path, hunkIndex: index, lines: proposal.lines })
    }
  })
  return resolutions
}

/** How a decision reads once made. */
export function decisionLabel(kind: DecisionKind): string {
  if (kind === 'proposal') return 'proposal accepted'
  if (kind === 'edited') return 'edited proposal'
  if (kind === 'both') return 'both kept'
  return `${kind} kept`
}
