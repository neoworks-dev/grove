// Blaming a line to the prompt that wrote it.
//
// Every edit step an agent makes is recorded here with the lines it added and
// the prompt it was answering, copied out of the session so it outlives it.
// Lines are matched by content rather than by commit: a hash of each added
// line, trimmed. That survives the line being committed, the commit being
// rebased or squashed, and the file moving, which a mapping keyed on commit or
// checkpoint hashes would not. `git blame` still decides when the line last
// changed — an agent's line that a person has since rewritten blames to the
// person — and a prompt only counts if it came before that commit.
//
// One file per repository (by its common git dir, so every worktree shares
// it), append-only, read once. When sharing is on, the records behind a commit
// also travel with it as a git note (see promptNotes.ts), and blame reads the
// note on the commit it lands on beside the local file.

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { simpleGit } from 'simple-git'
import type {
  AgentEditStep,
  CommitPrompt,
  LineBlame,
  LineCommit,
  PromptAttribution
} from '../shared/agents'
import { fetchNotes, pushNotes, readNote, unpublishedCommits, writeNote } from './promptNotes'

// A commit's author time has second resolution and the clocks agree only
// roughly, so a prompt a little after the commit still counts as before it.
const CLOCK_SLACK_MS = 60_000

// Lines too common to say anything about who wrote them: braces, `end`, `*/`.
const MIN_MEANINGFUL_LENGTH = 4

/** One edit step's added lines and the prompt behind them, as stored. */
export interface StoredAttribution {
  sessionId: string
  sessionTitle: string
  harness: string
  turnSeq: number | null
  stepIndex: number
  from: string
  prompt: string
  at: string
  /** Path → keys of the lines the step added there. */
  files: Record<string, string[]>
}

/** The session an edit was made in, as far as blame needs it. */
export interface BlameSession {
  id: string
  title: string
  harness: string
}

/** One added line of a commit and the record that wrote it. */
export interface AttributedLine {
  record: StoredAttribution
  path: string
  key: string
}

export interface PromptBlameOptions {
  /** Where the per-repository files are kept. */
  directory: string
  /** Whether a session still exists, so blame knows if it can be opened. */
  sessionExists(sessionId: string): boolean
  /** Whether prompt notes are written on commits and shared through the remote. */
  sharingNotes(): boolean
}

export class PromptBlame {
  private records = new Map<string, Promise<StoredAttribution[]>>()
  private commonDirs = new Map<string, Promise<string>>()

  constructor(private options: PromptBlameOptions) {}

  /** Records the lines one step added, with the prompt its turn answered. */
  async recordStep(
    worktreePath: string,
    session: BlameSession,
    step: AgentEditStep,
    turn: { from: string; prompt: string } | null
  ): Promise<void> {
    const diff = await simpleGit({ baseDir: worktreePath }).raw([
      'diff',
      '-U0',
      '--no-color',
      '--no-renames',
      '--no-ext-diff',
      step.before,
      step.after
    ])
    const files = keysByFile(addedLinesByFile(diff))
    if (Object.keys(files).length === 0) return

    let from = ''
    let prompt = ''
    if (turn) {
      from = turn.from
      prompt = turn.prompt
    }
    const record: StoredAttribution = {
      sessionId: session.id,
      sessionTitle: session.title,
      harness: session.harness,
      turnSeq: step.turnSeq,
      stepIndex: step.index,
      from,
      prompt,
      at: step.at,
      files
    }
    const commonDir = await this.commonDirOf(worktreePath)
    const records = await this.load(commonDir)
    records.push(record)
    await mkdir(this.options.directory, { recursive: true })
    await appendFile(this.fileOf(commonDir), `${JSON.stringify(record)}\n`)
  }

  /** The commit that last changed a line, and the prompt that wrote it. */
  async blameLine(
    worktreePath: string,
    relPath: string,
    line: number,
    text: string
  ): Promise<LineBlame> {
    const commit = await blameCommit(worktreePath, relPath, line, text)
    const key = lineKey(text)
    if (!key) return { commit, prompt: null }

    let records = await this.load(await this.commonDirOf(worktreePath))
    let committedAt: number | null = null
    if (commit) {
      committedAt = commit.time
      records = records.concat(await noteRecords(worktreePath, commit.sha))
    }
    const found = latestWriter(records, relPath, key, committedAt)
    if (!found) return { commit, prompt: null }
    return { commit, prompt: this.attributionOf(found) }
  }

  /** The prompts behind a commit's added lines, most lines first. */
  async commitPrompts(worktreePath: string, sha: string): Promise<CommitPrompt[]> {
    const tallies = new Map<string, CommitPrompt>()
    for (const attributed of await this.attributeCommit(worktreePath, sha)) {
      this.tally(tallies, attributed.record)
    }
    return [...tallies.values()].sort((left, right) => right.lines - left.lines)
  }

  /**
   * Before a push: notes every commit it is about to publish with the records
   * behind its agent-written lines. Returns what went wrong, or '' when
   * nothing did; a failure here must not stop the push itself.
   */
  async prepareToPublish(worktreePath: string): Promise<string> {
    if (!this.options.sharingNotes()) return ''
    try {
      for (const sha of await unpublishedCommits(worktreePath)) {
        await this.annotateCommit(worktreePath, sha)
      }
      return ''
    } catch (error) {
      return notesProblem('not written', error)
    }
  }

  /** Writes a commit's prompt note, unless it has one or no agent wrote any of it. */
  async annotateCommit(worktreePath: string, sha: string): Promise<void> {
    const existing = await readNote(worktreePath, sha)
    if (existing.length > 0) return
    const attributed = await this.attributeCommit(worktreePath, sha)
    if (attributed.length === 0) return
    const lines = narrowedRecords(attributed).map((record) => JSON.stringify(record))
    await writeNote(worktreePath, sha, lines)
  }

  /** After a push: shares the prompt notes with the remote. Returns what went wrong, or ''. */
  async publishNotes(worktreePath: string, remote: string): Promise<string> {
    if (!this.options.sharingNotes()) return ''
    try {
      await pushNotes(worktreePath, remote)
      return ''
    } catch (error) {
      return notesProblem('not shared', error)
    }
  }

  /** After a fetch: takes in the remote's prompt notes. Returns what went wrong, or ''. */
  async receiveNotes(worktreePath: string, remote: string): Promise<string> {
    if (!this.options.sharingNotes()) return ''
    try {
      await fetchNotes(worktreePath, remote)
      return ''
    } catch (error) {
      return notesProblem('not fetched', error)
    }
  }

  /** Each line a commit adds that an agent wrote, with the record that wrote it. */
  private async attributeCommit(worktreePath: string, sha: string): Promise<AttributedLine[]> {
    const output = await simpleGit({ baseDir: worktreePath }).raw([
      'show',
      '--format=%at',
      '-U0',
      '--no-color',
      '--no-renames',
      '--no-ext-diff',
      sha
    ])
    const newline = output.indexOf('\n')
    const committedAt = Number.parseInt(output.slice(0, newline), 10) * 1000
    const added = addedLinesByFile(output.slice(newline + 1))
    const local = await this.load(await this.commonDirOf(worktreePath))
    const records = local.concat(await noteRecords(worktreePath, sha))

    const attributed: AttributedLine[] = []
    for (const [path, lines] of added) {
      for (const text of lines) {
        const key = lineKey(text)
        if (!key) continue
        const record = latestWriter(records, path, key, committedAt)
        if (record) attributed.push({ record, path, key })
      }
    }
    return attributed
  }

  /** Counts one more line towards the prompt that wrote it. */
  private tally(tallies: Map<string, CommitPrompt>, record: StoredAttribution): void {
    const key = `${record.sessionId}\u0000${record.turnSeq}`
    const existing = tallies.get(key)
    if (existing) {
      existing.lines += 1
      return
    }
    tallies.set(key, { ...this.attributionOf(record), lines: 1 })
  }

  private attributionOf(record: StoredAttribution): PromptAttribution {
    return {
      sessionId: record.sessionId,
      sessionTitle: record.sessionTitle,
      harness: record.harness,
      turnSeq: record.turnSeq,
      stepIndex: record.stepIndex,
      from: record.from,
      prompt: record.prompt,
      at: record.at,
      sessionExists: this.options.sessionExists(record.sessionId)
    }
  }

  /** A repository's records, read from disk the first time they are asked for. */
  private load(commonDir: string): Promise<StoredAttribution[]> {
    let loading = this.records.get(commonDir)
    if (!loading) {
      loading = readRecords(this.fileOf(commonDir))
      this.records.set(commonDir, loading)
    }
    return loading
  }

  /** The git dir every worktree of a repository shares. */
  private commonDirOf(worktreePath: string): Promise<string> {
    let finding = this.commonDirs.get(worktreePath)
    if (!finding) {
      finding = resolveCommonDir(worktreePath)
      this.commonDirs.set(worktreePath, finding)
    }
    return finding
  }

  private fileOf(commonDir: string): string {
    const hash = createHash('sha1').update(commonDir).digest('hex').slice(0, 16)
    return join(this.options.directory, `${hash}.jsonl`)
  }
}

/** A notes failure as a line for the push or fetch summary, logged as well. */
function notesProblem(what: string, error: unknown): string {
  const message = `Prompt notes ${what}: ${(error as Error).message.trim()}`
  console.error(`[blame] ${message}`)
  return message
}

/** Absolute path of a worktree's common git dir. */
async function resolveCommonDir(worktreePath: string): Promise<string> {
  const output = await simpleGit({ baseDir: worktreePath }).raw(['rev-parse', '--git-common-dir'])
  const path = output.trim()
  if (isAbsolute(path)) return path
  return resolve(worktreePath, path)
}

/** Every record in a file; a line that does not parse is skipped. */
async function readRecords(file: string): Promise<StoredAttribution[]> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return parseRecords(text.split('\n'))
}

/** The records in a commit's prompt note. */
async function noteRecords(worktreePath: string, sha: string): Promise<StoredAttribution[]> {
  return parseRecords(await readNote(worktreePath, sha))
}

/** Records from JSON lines; a line that does not parse is skipped. */
function parseRecords(lines: string[]): StoredAttribution[] {
  const records: StoredAttribution[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    try {
      const record: StoredAttribution = JSON.parse(line)
      records.push(record)
    } catch {
      continue
    }
  }
  return records
}

/**
 * The records behind a commit's attributed lines, each cut down to the lines
 * it wrote there, so a note carries what explains its commit and no more.
 */
export function narrowedRecords(attributed: readonly AttributedLine[]): StoredAttribution[] {
  const keysByRecord = new Map<StoredAttribution, Record<string, Set<string>>>()
  for (const { record, path, key } of attributed) {
    let files = keysByRecord.get(record)
    if (!files) {
      files = {}
      keysByRecord.set(record, files)
    }
    if (!files[path]) files[path] = new Set()
    files[path].add(key)
  }

  const narrowed: StoredAttribution[] = []
  for (const [record, files] of keysByRecord) {
    const keys: Record<string, string[]> = {}
    for (const [path, set] of Object.entries(files)) keys[path] = [...set].sort()
    narrowed.push({ ...record, files: keys })
  }
  return narrowed
}

/**
 * The most recent record that added this line before it was committed. The
 * same path is preferred; any path is the fallback, for a file that moved.
 */
export function latestWriter(
  records: readonly StoredAttribution[],
  path: string,
  key: string,
  committedAt: number | null
): StoredAttribution | null {
  const samePath = latestMatching(records, key, committedAt, (record) => record.files[path])
  if (samePath) return samePath
  return latestMatching(records, key, committedAt, (record) => Object.values(record.files).flat())
}

/** The latest record whose keys, as `keysOf` reads them, hold `key`. */
function latestMatching(
  records: readonly StoredAttribution[],
  key: string,
  committedAt: number | null,
  keysOf: (record: StoredAttribution) => string[] | undefined
): StoredAttribution | null {
  let best: StoredAttribution | null = null
  for (const record of records) {
    if (!wroteBefore(record, committedAt)) continue
    const keys = keysOf(record)
    if (!keys || !keys.includes(key)) continue
    if (!best || record.at >= best.at) best = record
  }
  return best
}

/** Whether an edit could have produced a line committed at `committedAt`. */
function wroteBefore(record: StoredAttribution, committedAt: number | null): boolean {
  if (committedAt === null) return true
  return Date.parse(record.at) <= committedAt + CLOCK_SLACK_MS
}

/** A line as blame compares it, or null when it is too common to attribute. */
export function lineKey(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length < MIN_MEANINGFUL_LENGTH) return null
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null
  return createHash('sha1').update(trimmed).digest('hex').slice(0, 16)
}

/** Each file's added lines, as keys; files with none worth keeping are left out. */
function keysByFile(added: Map<string, string[]>): Record<string, string[]> {
  const files: Record<string, string[]> = {}
  for (const [path, lines] of added) {
    const keys = new Set<string>()
    for (const line of lines) {
      const key = lineKey(line)
      if (key) keys.add(key)
    }
    if (keys.size > 0) files[path] = [...keys]
  }
  return files
}

/** The lines a unified diff adds, by the path they are added to. */
export function addedLinesByFile(diff: string): Map<string, string[]> {
  const added = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      current = filesAddedTo(added, line.slice(4))
      continue
    }
    if (line.startsWith('diff --git ')) {
      current = null
      continue
    }
    if (current && line.startsWith('+')) current.push(line.slice(1))
  }
  return added
}

/** The list a `+++` header's file collects into; null for /dev/null (a deletion). */
function filesAddedTo(added: Map<string, string[]>, target: string): string[] | null {
  if (target === '/dev/null') return null
  let path = target
  if (path.startsWith('b/')) path = path.slice(2)
  let lines = added.get(path)
  if (!lines) {
    lines = []
    added.set(path, lines)
  }
  return lines
}

/**
 * The commit that last changed a line, or null when the line is not committed
 * — including when the file on disk no longer has this text there, because
 * the buffer it came from has unsaved changes.
 */
async function blameCommit(
  worktreePath: string,
  relPath: string,
  line: number,
  text: string
): Promise<LineCommit | null> {
  try {
    const output = await simpleGit({ baseDir: worktreePath }).raw([
      'blame',
      '--porcelain',
      '-L',
      `${line},${line}`,
      '--',
      relPath
    ])
    return parseBlamePorcelain(output, text)
  } catch {
    return null
  }
}

/** The commit `git blame --porcelain` names for one line, if the line still reads `text`. */
export function parseBlamePorcelain(output: string, text: string): LineCommit | null {
  const lines = output.split('\n')
  const sha = lines[0].split(' ')[0]
  if (!sha || /^0+$/.test(sha)) return null
  let author = ''
  let time = 0
  let summary = ''
  let content: string | null = null
  for (const line of lines.slice(1)) {
    if (line.startsWith('\t')) content = line.slice(1)
    else if (line.startsWith('author ')) author = line.slice('author '.length)
    else if (line.startsWith('author-time ')) time = Number.parseInt(line.slice(12), 10) * 1000
    else if (line.startsWith('summary ')) summary = line.slice('summary '.length)
  }
  if (content !== null && content !== text) return null
  return { sha, author, time, summary }
}
