// Keeping the places an agent points at on the code it meant.
//
// A location is a path and line numbers, and line numbers go stale as soon as
// anything above them is edited — by the user, or by the agent's next turn. So
// when the agent points, the lines it points at are taken down with it, and when
// the user opens the place, those lines are looked for in the file as it is now.
// A file that has gone is followed through git's rename detection, or found by
// its text among the files added since.

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type {
  AnchorText,
  CodeLocation,
  LocationAnchor,
  ResolvedLocation
} from '../../shared/agents'
import { changesSince, headCommit, untrackedFiles } from '../git'

// Lines either side of the range, to tell apart code that repeats.
const CONTEXT_LINES = 2
// A longer range is not a place any more; it is left without its text.
const MAX_ANCHORED_LINES = 400
// Looking for a moved file's text reads files; these keep that bounded.
const MAX_CANDIDATE_FILES = 200
const MAX_CANDIDATE_SIZE = 1024 * 1024

/** The range's lines, with their context, as they read in `fileText`; null when there is nothing to keep. */
export function anchorText(
  fileText: string,
  startLine: number,
  endLine: number
): AnchorText | null {
  const fileLines = fileText.split('\n')
  const start = startLine - 1
  if (start >= fileLines.length) return null
  if (endLine - startLine + 1 > MAX_ANCHORED_LINES) return null
  return {
    lines: fileLines.slice(start, endLine),
    before: fileLines.slice(Math.max(0, start - CONTEXT_LINES), start),
    after: fileLines.slice(endLine, endLine + CONTEXT_LINES)
  }
}

/**
 * Where a location's lines are in `fileText` now: at the same lines, moved to
 * the closest place that holds them, or changed when nothing does.
 */
export function relocate(location: CodeLocation, fileText: string): ResolvedLocation {
  const text = location.anchor?.text
  if (location.startLine === undefined || !text || text.lines.length === 0) {
    return { location, state: 'current' }
  }
  const fileLines = fileText.split('\n')
  const start = location.startLine - 1
  if (holdsAt(fileLines, start, text.lines, sameLine)) return { location, state: 'current' }

  let found = bestMatch(fileLines, text, start, sameLine)
  if (found === null) found = bestMatch(fileLines, text, start, sameIgnoringWhitespace)
  if (found !== null) return { location: shifted(location, found - start), state: 'moved' }

  // Rewritten inside. Its first line — a signature, usually — still says where
  // the place went, even though the lines under it can no longer be vouched for.
  // A blank one says nothing.
  if (text.lines[0].trim().length === 0) return { location, state: 'changed' }
  const opening: AnchorText = { lines: text.lines.slice(0, 1), before: text.before, after: [] }
  const openingAt = bestMatch(fileLines, opening, start, sameIgnoringWhitespace)
  if (openingAt === null) return { location, state: 'changed' }
  return { location: shifted(location, openingAt - start), state: 'changed' }
}

/** Takes down what each location's lines hold, so it can be found again after edits. */
export async function anchorLocations(
  root: string,
  locations: CodeLocation[]
): Promise<CodeLocation[]> {
  const commit = await headCommit(root)
  return Promise.all(
    locations.map(async (location) => {
      const anchor: LocationAnchor = {}
      if (commit) anchor.commit = commit
      const text = await rangeText(root, location)
      if (text) anchor.text = text
      if (!anchor.commit && !anchor.text) return location
      return { ...location, anchor }
    })
  )
}

/** Where each location is in the worktree now. Locations outside it are taken as they are. */
export async function resolveLocations(
  root: string,
  locations: CodeLocation[]
): Promise<ResolvedLocation[]> {
  return Promise.all(locations.map((location) => resolveLocation(root, location)))
}

/** Where one location is now: in its file, or in the file it became. */
async function resolveLocation(root: string, location: CodeLocation): Promise<ResolvedLocation> {
  const relPath = insideRoot(root, location.path)
  if (relPath === null) return { location, state: 'current' }

  const content = await readText(join(root, relPath))
  if (content !== null) return relocate(location, content)

  const newPath = await movedFile(root, relPath, location.anchor)
  if (newPath === null) return { location, state: 'removed' }
  const newContent = await readText(join(root, newPath))
  if (newContent === null) return { location, state: 'removed' }

  const moved = { ...location, path: join(root, newPath) }
  const resolved = relocate(moved, newContent)
  if (resolved.state === 'current') return { location: resolved.location, state: 'moved' }
  return resolved
}

/**
 * Where a file went: git's rename when git sees one, or else a new file that
 * holds the location's text. Git calls a file renamed only while it is mostly
 * unchanged, and a file moved with `mv` is a deletion and an untracked file to
 * it, so both kinds of new file are searched.
 */
async function movedFile(
  root: string,
  relPath: string,
  anchor: LocationAnchor | undefined
): Promise<string | null> {
  const candidates: string[] = []
  if (anchor?.commit) {
    const changes = await changesSince(root, anchor.commit)
    const renamed = changes.find((file) => file.oldPath === relPath)
    if (renamed) return renamed.path
    for (const file of changes) {
      if (file.changeType === 'added') candidates.push(file.path)
    }
  }
  candidates.push(...(await untrackedFiles(root)))
  return fileHolding(root, relPath, candidates.slice(0, MAX_CANDIDATE_FILES), anchor?.text)
}

/**
 * The candidate that holds the text; failing that, the one holding its first
 * line, as a file both moved and edited does; failing that, one of the same
 * name.
 */
async function fileHolding(
  root: string,
  relPath: string,
  candidates: string[],
  text: AnchorText | undefined
): Promise<string | null> {
  const name = basename(relPath)
  // Same name first: the likeliest place, and the one to prefer on a tie.
  const ordered = [
    ...candidates.filter((candidate) => basename(candidate) === name),
    ...candidates.filter((candidate) => basename(candidate) !== name)
  ]
  const sameName = ordered.find((candidate) => basename(candidate) === name) ?? null
  if (!text) return sameName

  const contents = new Map<string, string[]>()
  for (const candidate of ordered) {
    const content = await readText(join(root, candidate), MAX_CANDIDATE_SIZE)
    if (content !== null) contents.set(candidate, content.split('\n'))
  }
  for (const [candidate, fileLines] of contents) {
    if (bestMatch(fileLines, text, 0, sameIgnoringWhitespace) !== null) return candidate
  }
  if (text.lines[0].trim().length > 0) {
    const opening: AnchorText = { lines: text.lines.slice(0, 1), before: [], after: [] }
    for (const [candidate, fileLines] of contents) {
      if (bestMatch(fileLines, opening, 0, sameIgnoringWhitespace) !== null) return candidate
    }
  }
  return sameName
}

/** The anchor text for a location's range, read from its file; null for a whole file or a file outside the root. */
async function rangeText(root: string, location: CodeLocation): Promise<AnchorText | null> {
  if (location.startLine === undefined) return null
  const relPath = insideRoot(root, location.path)
  if (relPath === null) return null
  const content = await readText(join(root, relPath))
  if (content === null) return null
  return anchorText(content, location.startLine, location.endLine ?? location.startLine)
}

/** The location with its lines and annotations moved by `delta`. */
function shifted(location: CodeLocation, delta: number): CodeLocation {
  const moved: CodeLocation = { ...location }
  if (location.startLine !== undefined) moved.startLine = location.startLine + delta
  if (location.endLine !== undefined) moved.endLine = location.endLine + delta
  if (location.annotations) {
    moved.annotations = location.annotations.map((annotation) => ({
      ...annotation,
      line: annotation.line + delta
    }))
  }
  return moved
}

type LineComparison = (first: string, second: string) => boolean

/** Lines that read the same. */
function sameLine(first: string, second: string): boolean {
  return first === second
}

/** Lines that read the same once whitespace is ignored, as after reformatting. */
function sameIgnoringWhitespace(first: string, second: string): boolean {
  return first.replace(/\s+/g, '') === second.replace(/\s+/g, '')
}

/** Whether the file holds `lines` starting at the 0-based line `start`. */
function holdsAt(
  fileLines: string[],
  start: number,
  lines: string[],
  compare: LineComparison
): boolean {
  if (start < 0 || start + lines.length > fileLines.length) return false
  return lines.every((line, offset) => compare(fileLines[start + offset], line))
}

/**
 * The 0-based line where the file holds the anchored lines, or null. Where they
 * appear more than once, the place whose surroundings match best wins, then the
 * one nearest `near`.
 */
function bestMatch(
  fileLines: string[],
  text: AnchorText,
  near: number,
  compare: LineComparison
): number | null {
  let best: number | null = null
  let bestScore = -1
  let bestDistance = Infinity
  const last = fileLines.length - text.lines.length
  for (let start = 0; start <= last; start += 1) {
    if (!holdsAt(fileLines, start, text.lines, compare)) continue
    const score = contextScore(fileLines, start, text, compare)
    const distance = Math.abs(start - near)
    if (score < bestScore) continue
    if (score === bestScore && distance >= bestDistance) continue
    best = start
    bestScore = score
    bestDistance = distance
  }
  return best
}

/** How many of the lines around a match are the ones that were around the range. */
function contextScore(
  fileLines: string[],
  start: number,
  text: AnchorText,
  compare: LineComparison
): number {
  let score = 0
  text.before.forEach((line, index) => {
    const fileLine = fileLines[start - text.before.length + index]
    if (fileLine !== undefined && compare(fileLine, line)) score += 1
  })
  text.after.forEach((line, index) => {
    const fileLine = fileLines[start + text.lines.length + index]
    if (fileLine !== undefined && compare(fileLine, line)) score += 1
  })
  return score
}

/** A path relative to the root, or null when it lies outside it. */
function insideRoot(root: string, path: string): string | null {
  let absolute = path
  if (!isAbsolute(absolute)) absolute = join(root, path)
  const relPath = relative(root, absolute)
  if (relPath.length === 0 || relPath.startsWith('..') || isAbsolute(relPath)) return null
  return relPath
}

/** A file's text, or null when it is missing, not a file, or larger than `limit`. */
async function readText(path: string, limit = Infinity): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > limit) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
