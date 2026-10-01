// Resolving merge conflicts with an agent.
//
// The agent is asked in an ordinary session, given every conflict with both
// sides, the base and each side's history, and answers one conflict at a time
// through `propose_conflict_resolution`. Proposals are held here, not written:
// the user accepts, edits or rejects each, and only once every conflict in the
// files under review is settled are they written back and staged together.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import type {
  ConflictHunk,
  ConflictProposal,
  ConflictResolutionLines,
  ConflictedFile
} from '../shared/types'
import { conflictsInFile, listConflicts, parseConflictHunks } from './conflicts'

// Each side of a conflict is quoted into the prompt up to this many lines; a
// longer one the agent reads from the file itself.
const QUOTED_SIDE_LINES = 60
const HISTORY_COMMITS = 10

/** Ties a proposal to one conflict's exact content. */
export function hunkFingerprint(hunk: ConflictHunk): string {
  let base: string[] = []
  if (hunk.base) base = hunk.base
  const parts = [hunk.ours.join('\n'), base.join('\n'), hunk.theirs.join('\n')]
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/** What an agent proposed for one conflict, as the tool receives it. */
export interface ProposalInput {
  path: string
  /** 1-based, as the prompt numbers a file's conflicts. */
  conflict: number
  resolution: string | null
  reason: string
  confident: boolean
  sessionId: string
}

export interface ConflictProposalsOptions {
  /** Tells the renderer a worktree's proposals changed. */
  publish(worktreePath: string): void
}

export class ConflictProposals {
  private byWorktree = new Map<string, Map<string, ConflictProposal>>()

  constructor(private options: ConflictProposalsOptions) {}

  /**
   * Records a proposal for a conflict that exists right now. Returns what the
   * agent is told: an error for a conflict that is not there.
   */
  async propose(
    worktreePath: string,
    input: ProposalInput
  ): Promise<{ ok: boolean; message: string }> {
    const hunks = await conflictsInFile(worktreePath, input.path).catch(() => [])
    const hunk = hunks[input.conflict - 1]
    if (!hunk) {
      return {
        ok: false,
        message: `${input.path} has no conflict ${input.conflict}; it has ${hunks.length}.`
      }
    }
    let lines: string[] | null = null
    if (input.resolution !== null) lines = resolutionLines(input.resolution, hunk)
    const proposal: ConflictProposal = {
      path: input.path,
      hunkIndex: input.conflict - 1,
      fingerprint: hunkFingerprint(hunk),
      lines,
      reason: input.reason,
      confident: input.confident && lines !== null,
      sessionId: input.sessionId
    }
    this.mapOf(worktreePath).set(proposalKey(proposal.path, proposal.hunkIndex), proposal)
    this.options.publish(worktreePath)
    return { ok: true, message: await this.progress(worktreePath) }
  }

  /** The proposals that still match their conflicts; stale ones are dropped. */
  async current(worktreePath: string): Promise<ConflictProposal[]> {
    const proposals = this.mapOf(worktreePath)
    if (proposals.size === 0) return []
    const files = await listConflicts(worktreePath)
    for (const [key, proposal] of proposals) {
      if (!stillApplies(proposal, files)) proposals.delete(key)
    }
    return [...proposals.values()]
  }

  /** Forgets a worktree's proposals: the user dismissed them, or wrote them back. */
  clear(worktreePath: string): void {
    this.byWorktree.delete(worktreePath)
    this.options.publish(worktreePath)
  }

  /** How far the agent has got, for its tool result. */
  private async progress(worktreePath: string): Promise<string> {
    const files = await listConflicts(worktreePath)
    const total = files.reduce((sum, file) => sum + file.hunks.length, 0)
    const proposed = (await this.current(worktreePath)).length
    return `Recorded. ${proposed} of ${total} conflicts have a proposal.`
  }

  private mapOf(worktreePath: string): Map<string, ConflictProposal> {
    let proposals = this.byWorktree.get(worktreePath)
    if (!proposals) {
      proposals = new Map()
      this.byWorktree.set(worktreePath, proposals)
    }
    return proposals
  }
}

function proposalKey(path: string, hunkIndex: number): string {
  return `${path}\u0000${hunkIndex}`
}

/** Whether the conflict a proposal was made for is still in its file, unchanged. */
function stillApplies(proposal: ConflictProposal, files: ConflictedFile[]): boolean {
  const file = files.find((entry) => entry.path === proposal.path)
  if (!file) return false
  const hunk = file.hunks[proposal.hunkIndex]
  if (!hunk) return false
  return hunkFingerprint(hunk) === proposal.fingerprint
}

/**
 * A proposed resolution as the region's lines. A final newline is the end of
 * the last line, not an empty line after it; a CRLF file gets its CRs back.
 */
export function resolutionLines(resolution: string, hunk: ConflictHunk): string[] {
  const lines = resolution.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const sample = [...hunk.ours, ...hunk.theirs][0]
  if (sample === undefined || !sample.endsWith('\r')) return lines
  return lines.map((line) => `${line}\r`)
}

/**
 * The file with the given conflicts replaced. Applied from the bottom up, so
 * one replacement never moves the lines of the next.
 */
export function applyResolutions(
  content: string,
  resolutions: { hunkIndex: number; lines: string[] }[]
): string {
  const hunks = parseConflictHunks(content)
  const lines = content.split('\n')
  const ordered = [...resolutions].sort((left, right) => right.hunkIndex - left.hunkIndex)
  for (const resolution of ordered) {
    const hunk = hunks[resolution.hunkIndex]
    if (!hunk) throw new Error(`conflict ${resolution.hunkIndex + 1} is no longer in the file`)
    lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...resolution.lines)
  }
  return lines.join('\n')
}

/**
 * Writes settled conflicts back, file by file, and stages each file left with
 * no markers. Every file is checked before any is written, so a stale
 * resolution changes nothing.
 */
export async function writeResolutions(
  worktreePath: string,
  resolutions: ConflictResolutionLines[]
): Promise<string[]> {
  const byPath = new Map<string, ConflictResolutionLines[]>()
  for (const resolution of resolutions) {
    let list = byPath.get(resolution.path)
    if (!list) {
      list = []
      byPath.set(resolution.path, list)
    }
    list.push(resolution)
  }

  const results: { path: string; content: string }[] = []
  for (const [path, list] of byPath) {
    const target = join(worktreePath, path)
    const content = await readFile(target, 'utf8')
    results.push({ path, content: applyResolutions(content, list) })
  }

  const staged: string[] = []
  for (const result of results) {
    await writeFile(join(worktreePath, result.path), result.content, 'utf8')
    if (parseConflictHunks(result.content).length > 0) continue
    await simpleGit({ baseDir: worktreePath }).raw(['add', '--', result.path])
    staged.push(result.path)
  }
  return staged
}

// ── The prompt ──────────────────────────────────────────────────

/** What the worktree is in the middle of, and the commit being brought in. */
interface Operation {
  verb: string
  incoming: string | null
}

/** The operation that left the conflicts: a merge, rebase, cherry-pick or revert. */
async function operationOf(worktreePath: string): Promise<Operation> {
  const candidates: [string, string][] = [
    ['MERGE_HEAD', 'merging'],
    ['REBASE_HEAD', 'rebasing'],
    ['CHERRY_PICK_HEAD', 'cherry-picking'],
    ['REVERT_HEAD', 'reverting']
  ]
  for (const [ref, verb] of candidates) {
    if (await refExists(worktreePath, ref)) return { verb, incoming: ref }
  }
  return { verb: 'applying changes', incoming: null }
}

async function refExists(worktreePath: string, ref: string): Promise<boolean> {
  try {
    const out = await simpleGit({ baseDir: worktreePath }).raw(['rev-parse', '-q', '--verify', ref])
    return out.trim().length > 0
  } catch {
    return false
  }
}

/** One side's recent commits touching the files, as `git log --oneline` would put them. */
async function sideHistory(
  worktreePath: string,
  range: string,
  paths: string[]
): Promise<string> {
  try {
    const out = await simpleGit({ baseDir: worktreePath }).raw([
      'log',
      `-n${HISTORY_COMMITS}`,
      '--format=%h %an: %s',
      range,
      '--',
      ...paths
    ])
    return out.trim()
  } catch {
    return ''
  }
}

/** The history section of the prompt: each side's commits since they split. */
async function historySection(
  worktreePath: string,
  operation: Operation,
  paths: string[]
): Promise<string> {
  if (!operation.incoming) return ''
  let base = ''
  try {
    const out = await simpleGit({ baseDir: worktreePath }).raw([
      'merge-base',
      'HEAD',
      operation.incoming
    ])
    base = out.trim()
  } catch {
    return ''
  }
  const [ours, theirs] = await Promise.all([
    sideHistory(worktreePath, `${base}..HEAD`, paths),
    sideHistory(worktreePath, `${base}..${operation.incoming}`, paths)
  ])
  return [
    `History since the sides split (merge base ${base.slice(0, 10)}):`,
    `- HEAD:\n${indent(ours || '(no commits touching these files)')}`,
    `- ${operation.incoming}:\n${indent(theirs || '(no commits touching these files)')}`
  ].join('\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

/** One side of a conflict, quoted, or cut short with a note to read the file. */
function quoteSide(label: string, lines: string[]): string {
  const shown = lines.slice(0, QUOTED_SIDE_LINES).map((line) => line.replace(/\r$/, ''))
  let body = shown.join('\n')
  if (lines.length > QUOTED_SIDE_LINES) {
    body += `\n… ${lines.length - QUOTED_SIDE_LINES} more lines; read the file`
  }
  return `${label}:\n\`\`\`\n${body}\n\`\`\``
}

/** One conflict as the prompt lists it. */
function describeHunk(path: string, hunk: ConflictHunk, number: number): string {
  const parts = [
    `### ${path}, conflict ${number} (lines ${hunk.startLine}–${hunk.endLine})`,
    quoteSide(`Ours (${hunk.oursLabel || 'HEAD'})`, hunk.ours)
  ]
  if (hunk.base) parts.push(quoteSide('Base', hunk.base))
  parts.push(quoteSide(`Theirs (${hunk.theirsLabel || 'incoming'})`, hunk.theirs))
  return parts.join('\n')
}

/**
 * The prompt that asks an agent to propose a resolution for every conflict in
 * the given files — all conflicted files when none are named.
 */
export async function resolutionPrompt(
  worktreePath: string,
  paths: string[] | null
): Promise<string> {
  let files = (await listConflicts(worktreePath)).filter((file) => file.hunks.length > 0)
  if (paths) files = files.filter((file) => paths.includes(file.path))
  if (files.length === 0) throw new Error('There are no conflicts to resolve.')

  const operation = await operationOf(worktreePath)
  const filePaths = files.map((file) => file.path)
  const conflicts = files.flatMap((file) =>
    file.hunks.map((hunk, index) => describeHunk(file.path, hunk, index + 1))
  )
  const history = await historySection(worktreePath, operation, filePaths)

  return [
    `This worktree has merge conflicts from ${operation.verb}. Propose a resolution for each conflict below.`,
    'For each one: read both sides, the base (`git show :1:<path>` when it is not quoted), the ' +
      'history of each side, and whatever else in the code you need to understand what each side ' +
      'meant. Then call `propose_conflict_resolution` once per conflict with the lines that should ' +
      'replace the whole conflict region, markers included, and one sentence on why.',
    'If you are not confident how to combine a conflict, call it with `confident: false` and say ' +
      'what is unclear instead of guessing.',
    'Do not edit the conflicted files, stage or commit anything: the user reviews every proposal ' +
      'and grove writes the accepted ones.',
    history,
    ...conflicts
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
}
