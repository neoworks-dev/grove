// Branches, tags and stashes: listing them, acting on them, and comparing any
// two refs. Every operation is one git command; the only logic here is reading
// git's output and refusing to leave a worktree half-way through an operation
// Grove has no UI to finish.

import { simpleGit, type SimpleGit } from 'simple-git'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { conflictedFiles, parseNameStatusZ } from './git'
import { LOG_FORMAT, log, parseLog } from './history'
import type { BranchRef, RefComparison, RefList, StashEntry, TagRef } from '../shared/types'

const FIELD = '\x1f'
const RECORD = '\x1e'

// One ref per record. `*objectname` is the commit an annotated tag points at;
// `creatordate` is the tag's own date for an annotated tag, the commit's
// otherwise. `symref` is set on `origin/HEAD`, which is not a branch.
const REF_FIELDS = [
  '%(refname)',
  '%(refname:short)',
  '%(objectname)',
  '%(*objectname)',
  '%(subject)',
  '%(creatordate:iso-strict)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(worktreepath)',
  '%(symref)'
]
const REF_FORMAT = `${REF_FIELDS.join('%1f')}%1e`

// The most commits a comparison lists on either side.
const COMPARE_LIMIT = 200

/** simple-git for a worktree. */
function gitFor(worktreePath: string): SimpleGit {
  return simpleGit({ baseDir: worktreePath })
}

// ── Listing ──────────────────────────────────────────────────────

/** Every local branch, remote-tracking branch and tag. */
export async function listRefs(worktreePath: string): Promise<RefList> {
  const output = await gitFor(worktreePath).raw([
    'for-each-ref',
    `--format=${REF_FORMAT}`,
    '--sort=-creatordate',
    'refs/heads',
    'refs/remotes',
    'refs/tags'
  ])
  return parseRefs(output)
}

/** Sorts `for-each-ref` records written with REF_FORMAT into branches and tags. */
export function parseRefs(output: string): RefList {
  const list: RefList = { local: [], remote: [], tags: [] }
  for (const record of output.split(RECORD)) {
    const fields = record.replace(/^\n/, '').split(FIELD)
    if (fields.length < REF_FIELDS.length) continue
    addRef(list, fields)
  }
  return list
}

/** Files one parsed record under the list it belongs to. */
function addRef(list: RefList, fields: string[]): void {
  const [fullName, name, sha, peeledSha, subject, date, head] = fields
  const [upstream, track, worktreePath, symref] = fields.slice(7)
  if (fullName.startsWith('refs/tags/')) {
    list.tags.push(tagRef(name, sha, peeledSha, subject, date))
    return
  }
  if (symref.length > 0) return
  const branch: BranchRef = {
    name,
    sha,
    subject,
    date,
    current: head === '*',
    upstream: emptyToNull(upstream),
    ...parseTrack(track),
    worktreePath: emptyToNull(worktreePath),
    remote: null
  }
  if (fullName.startsWith('refs/remotes/')) {
    branch.remote = name.split('/')[0]
    list.remote.push(branch)
    return
  }
  list.local.push(branch)
}

/** A tag, pointed at the commit an annotated tag wraps. */
function tagRef(
  name: string,
  sha: string,
  peeledSha: string,
  subject: string,
  date: string
): TagRef {
  let commit = sha
  if (peeledSha.length > 0) commit = peeledSha
  return { name, sha: commit, subject, date }
}

/** Reads `%(upstream:track,nobracket)`: "ahead 2, behind 1", "gone", or nothing. */
export function parseTrack(track: string): {
  ahead: number
  behind: number
  upstreamGone: boolean
} {
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: countOf(ahead),
    behind: countOf(behind),
    upstreamGone: track === 'gone'
  }
}

/** The number a `(\d+)` match captured, or 0 without a match. */
function countOf(match: RegExpExecArray | null): number {
  if (match === null) return 0
  return Number(match[1])
}

/** A field git leaves empty, as null. */
function emptyToNull(value: string): string | null {
  if (value.length === 0) return null
  return value
}

/** Every stash entry, newest first. */
export async function listStashes(worktreePath: string): Promise<StashEntry[]> {
  const output = await gitFor(worktreePath).raw(['stash', 'list', `--format=%gd%x1f${LOG_FORMAT}`])
  return parseStashes(output)
}

/** Splits the ref name off each record, then reads the rest as a log entry. */
export function parseStashes(output: string): StashEntry[] {
  const entries: StashEntry[] = []
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '')
    const separator = trimmed.indexOf(FIELD)
    if (separator < 0) continue
    const [commit] = parseLog(`${trimmed.slice(separator + 1)}${RECORD}`)
    if (commit) entries.push({ ref: trimmed.slice(0, separator), commit })
  }
  return entries
}

// ── Branches ─────────────────────────────────────────────────────

/**
 * Checks a branch out. A remote-tracking branch checks out its local
 * counterpart, creating it to track the remote one when there is none yet.
 */
export async function checkout(
  worktreePath: string,
  branch: string,
  remote: boolean
): Promise<void> {
  const git = gitFor(worktreePath)
  if (!remote) {
    await git.raw(['switch', branch])
    return
  }
  const localName = branch.slice(branch.indexOf('/') + 1)
  const existing = await git.raw(['branch', '--list', localName])
  if (existing.trim().length > 0) await git.raw(['switch', localName])
  else await git.raw(['switch', '--track', branch])
}

/**
 * Rebases the checked-out branch onto a ref. A rebase that stops on conflicts
 * is aborted, leaving the branch exactly as it was: Grove can resolve a merge's
 * conflicts but not walk a rebase through them commit by commit.
 */
export async function rebaseOnto(worktreePath: string, onto: string): Promise<string> {
  const git = gitFor(worktreePath)
  try {
    const out = await git.raw(['rebase', onto])
    if (!(await rebaseInProgress(worktreePath))) return out.trim()
  } catch (err) {
    if (!(await rebaseInProgress(worktreePath))) throw err
  }
  const files = await conflictedFiles(worktreePath)
  await git.raw(['rebase', '--abort'])
  throw new Error(
    `Rebasing onto ${onto} stopped on conflicts in ${files.join(', ')}. ` +
      'The rebase was aborted and the branch is unchanged — merge instead, or rebase in a terminal to resolve them.'
  )
}

/** Whether a rebase is stopped part-way in this worktree. */
async function rebaseInProgress(worktreePath: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const out = await gitFor(worktreePath).raw(['rev-parse', '--git-path', name])
    let path = out.trim()
    if (!isAbsolute(path)) path = join(worktreePath, path)
    if (existsSync(path)) return true
  }
  return false
}

// ── Stashes ──────────────────────────────────────────────────────

/** Stashes every uncommitted change, untracked files included. */
export async function stashPush(worktreePath: string, message: string): Promise<void> {
  const args = ['stash', 'push', '--include-untracked']
  if (message.trim().length > 0) args.push('--message', message)
  await gitFor(worktreePath).raw(args)
}

/** Applies a stash to the working tree, keeping it (`apply`) or dropping it after (`pop`). */
export async function stashApply(worktreePath: string, ref: string, pop: boolean): Promise<void> {
  let command = 'apply'
  if (pop) command = 'pop'
  await gitFor(worktreePath).raw(['stash', command, ref])
}

/** Throws a stash away. */
export async function stashDrop(worktreePath: string, ref: string): Promise<void> {
  await gitFor(worktreePath).raw(['stash', 'drop', ref])
}

// ── Compare ──────────────────────────────────────────────────────

/**
 * Sets `head` beside `base`: the commits each has that the other lacks, and
 * every file that differs. A null `head` is the working tree, which has no
 * commits of its own, so its commits are HEAD's.
 */
export async function compareRefs(
  worktreePath: string,
  base: string,
  head: string | null
): Promise<RefComparison> {
  let headRevision = 'HEAD'
  if (head !== null) headRevision = head
  const limit = `--max-count=${COMPARE_LIMIT}`
  const [ahead, behind] = await Promise.all([
    log(worktreePath, [limit, `${base}..${headRevision}`]),
    log(worktreePath, [limit, `${headRevision}..${base}`])
  ])
  const diffArgs = ['diff', '-M', '--name-status', '-z', base]
  if (head !== null) diffArgs.push(head)
  const files = parseNameStatusZ(await gitFor(worktreePath).raw(diffArgs), false)
  return { ahead, behind, files }
}
