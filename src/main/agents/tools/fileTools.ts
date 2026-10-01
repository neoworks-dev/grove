// Reading and changing files in grove mode, in hashline's LINE#ID format.
//
// A read shows every line with a short hash of its text; an edit names the
// lines it changes by those tags. The model never has to reproduce the text it
// replaces, which is most of what an edit costs in tokens, and a tag that no
// longer matches fails the edit instead of changing the wrong line.

import { readdir } from 'fs/promises'
import type { ToolCallUpdate } from '@neoworks/harness'
import type { GroveTool, GroveToolContext } from '../harness'
import { applyEdits, StaleAnchorError, type HashlineEdit } from './hashline/apply'
import { formatLines, parseAnchor } from './hashline/hash'
import {
  displayPath,
  joinText,
  resolvePath,
  splitText,
  type FileText,
  type WorkspaceFiles
} from './workspaceFiles'

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024
/** Lines of context an edit's result shows around what it changed. */
const RESULT_CONTEXT = 2
/** The most changed lines an edit's result shows fresh tags for. */
const RESULT_LINES = 60
/** Identical edits in a row that change nothing before the model is told to re-read. */
const NOOP_LIMIT = 3

const PATH_PROPERTY = {
  type: 'string',
  description: 'File path, absolute or relative to the working directory.'
}

/** read, edit and write over the given files. */
export function fileTools(files: WorkspaceFiles): GroveTool[] {
  return [readTool(files), editTool(files), writeTool(files)]
}

function readTool(files: WorkspaceFiles): GroveTool {
  return {
    name: 'read',
    alwaysLoad: true,
    summary: 'Read a file',
    promptGuidelines: [
      'Find code with grep, find or lsp before reading it',
      'Read only the part you need, with offset and limit'
    ],
    description:
      'Read a text file, or list a directory. Each line comes back as LINE#ID:text, e.g. `5#ZP:  const x = 1;`. ' +
      `Pass the LINE#ID tags to edit to change lines. Shows at most ${MAX_LINES} lines or 50KB; use offset and limit for more.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        offset: { type: 'integer', minimum: 1, description: 'First line to show (1-based).' },
        limit: { type: 'integer', minimum: 1, description: 'Number of lines to show.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{path}', input: 'hidden', result: 'code', languageFrom: 'path' },

    async execute(input, context) {
      const path = resolvePath(context.workspaceRoot, String(input.path))
      const listing = await listDirectory(path)
      if (listing !== null) return { content: listing }
      const file = await files.read(path)
      if (!file.exists) return { content: `${String(input.path)} does not exist.`, isError: true }
      return { content: shownLines(file, input) }
    }
  }
}

function editTool(files: WorkspaceFiles): GroveTool {
  const noops = new Map<string, { payload: string; count: number }>()

  return {
    name: 'edit',
    alwaysLoad: true,
    summary: 'Edit a file',
    promptGuidelines: ['Edit with the LINE#ID tags from read, every change to a file in one call'],
    description: [
      'Edit a file by LINE#ID tags from read. Edits refer to the file as last read; if it changed, the call fails and shows fresh tags.',
      'replace: pos, or pos..end inclusive; lines [] deletes. append/prepend: after/before pos, or at the end/start; without pos they create a missing file.',
      'The result shows the changed lines with fresh tags; tags below the first change are stale. Replace whole constructs; copy indentation exactly.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace', 'append', 'prepend'] },
              pos: { type: 'string', description: 'LINE#ID' },
              end: { type: 'string', description: 'LINE#ID' },
              lines: { type: 'array', items: { type: 'string' } },
              current: { type: 'string', description: "Single-line replace: the line's current text." }
            },
            required: ['op', 'lines'],
            additionalProperties: false
          }
        }
      },
      required: ['path', 'edits'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{path}', edits: true },

    async describe(input, context) {
      const planned = await planEdit(files, input, context)
      return changeOf(context, planned.path, planned.file, planned.lines)
    },

    async execute(input, context) {
      let planned: PlannedEdit
      try {
        planned = await planEdit(files, input, context)
      } catch (cause) {
        return { content: editFailure(cause), isError: true }
      }

      if (!planned.changed) return noChange(noops, planned.path, input)
      noops.delete(planned.path)

      await files.write(planned.path, planned.file, planned.lines)
      context.report?.(changeOf(context, planned.path, planned.file, planned.lines))
      return { content: editedReport(planned, input) }
    }
  }
}

function writeTool(files: WorkspaceFiles): GroveTool {
  return {
    name: 'write',
    alwaysLoad: true,
    summary: 'Write a file',
    promptGuidelines: ['Use write only for new files or complete rewrites'],
    description:
      'Create a file, or replace one whole. For changing part of an existing file use edit, which costs far fewer tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        content: { type: 'string', description: 'The whole new content of the file.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{path}', edits: true },

    async describe(input, context) {
      const path = resolvePath(context.workspaceRoot, String(input.path))
      const file = await files.read(path)
      return changeOf(context, path, file, splitText(String(input.content)).lines)
    },

    async execute(input, context) {
      const path = resolvePath(context.workspaceRoot, String(input.path))
      const file = await files.read(path)
      const written = splitText(String(input.content))
      // The file keeps the line endings the model wrote it with.
      await files.write(path, { ...file, eol: written.eol, finalNewline: written.finalNewline }, written.lines)
      context.report?.(changeOf(context, path, file, written.lines))
      let verb = 'Wrote'
      if (!file.exists) verb = 'Created'
      return { content: `${verb} ${String(input.path)} (${written.lines.length} lines).` }
    }
  }
}

// ── Reading ─────────────────────────────────────────────────────

/** A directory's entries, directories marked with a slash, or null for a file. */
async function listDirectory(path: string): Promise<string | null> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (entries === null) return null
  const names = entries
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`
      return entry.name
    })
    .sort()
  if (names.length === 0) return '(empty directory)'
  return names.join('\n')
}

/** The lines a read asked for, tagged, cut to fit the size limit. */
function shownLines(file: FileText, input: Record<string, unknown>): string {
  let first = 1
  if (typeof input.offset === 'number') first = Math.max(1, input.offset)
  let limit = MAX_LINES
  if (typeof input.limit === 'number') limit = Math.min(input.limit, MAX_LINES)

  const shown: string[] = []
  let bytes = 0
  for (const [index, line] of file.lines.slice(first - 1, first - 1 + limit).entries()) {
    const formatted = formatLines([line], first + index)
    bytes += Buffer.byteLength(formatted) + 1
    if (bytes > MAX_BYTES && shown.length > 0) break
    shown.push(formatted)
  }

  const notes: string[] = []
  const last = first + shown.length - 1
  if (first > 1 || last < file.lines.length) {
    notes.push(`[Lines ${first}-${last} of ${file.lines.length}.]`)
  }
  if (file.unsaved) notes.push('[Open in the editor with unsaved changes; this is the editor’s text.]')
  if (notes.length === 0) return shown.join('\n')
  return `${shown.join('\n')}\n\n${notes.join('\n')}`
}

// ── Editing ─────────────────────────────────────────────────────

interface PlannedEdit {
  path: string
  file: FileText
  lines: string[]
  changed: boolean
  warnings: string[]
}

type RawEdit = { op: string; pos?: string; end?: string; lines?: string[] | null; current?: string }

/** What an edit call would make of the file, checked against it as it is now. */
async function planEdit(
  files: WorkspaceFiles,
  input: Record<string, unknown>,
  context: GroveToolContext
): Promise<PlannedEdit> {
  const path = resolvePath(context.workspaceRoot, String(input.path))
  const edits = (input.edits as RawEdit[]).map(parseEdit)
  const file = await files.read(path)
  if (!file.exists && edits.some((edit) => edit.op === 'replace' || edit.pos)) {
    throw new Error(`${String(input.path)} does not exist. Create it with append or prepend and no pos.`)
  }
  const result = applyEdits(file.lines, edits)
  return { path, file, lines: result.lines, changed: result.changed, warnings: result.warnings }
}

function parseEdit(raw: RawEdit): HashlineEdit {
  let lines: string[] = []
  if (raw.lines) lines = raw.lines
  let pos: HashlineEdit['pos']
  if (raw.pos) pos = parseAnchor(raw.pos)
  if (raw.op === 'replace') {
    if (!pos) throw new Error('replace needs "pos"')
    let end: HashlineEdit['pos']
    if (raw.end) end = parseAnchor(raw.end)
    return { op: 'replace', pos, end, lines, current: raw.current }
  }
  if (raw.op === 'append' || raw.op === 'prepend') return { op: raw.op, pos, lines }
  throw new Error(`unknown op "${raw.op}"`)
}

function editFailure(cause: unknown): string {
  if (cause instanceof StaleAnchorError) return cause.message
  return `Edit failed: ${(cause as Error).message}`
}

/** The answer to an edit that changed nothing, telling the model to stop once it repeats. */
function noChange(
  noops: Map<string, { payload: string; count: number }>,
  path: string,
  input: Record<string, unknown>
): { content: string; isError?: boolean } {
  const payload = JSON.stringify(input.edits)
  const previous = noops.get(path)
  let count = 1
  if (previous && previous.payload === payload) count = previous.count + 1
  noops.set(path, { payload, count })
  if (count >= NOOP_LIMIT) {
    return {
      content: `STOP: this edit changed nothing ${count} times in a row. Re-read ${String(input.path)} before editing it again.`,
      isError: true
    }
  }
  return { content: 'No changes: the file already has this content.' }
}

/**
 * What an edit did, with the changed lines under fresh tags so the next edit
 * to the same place needs no second read.
 */
function editedReport(planned: PlannedEdit, input: Record<string, unknown>): string {
  let verb = 'Edited'
  if (!planned.file.exists) verb = 'Created'
  const report = [`${verb} ${String(input.path)}.`]
  for (const warning of planned.warnings) report.push(`Note: ${warning}`)
  const region = changedRegion(planned.file.lines, planned.lines)
  if (region) {
    const first = Math.max(1, region.first - RESULT_CONTEXT)
    const last = Math.min(planned.lines.length, region.last + RESULT_CONTEXT, first + RESULT_LINES - 1)
    report.push('', formatLines(planned.lines.slice(first - 1, last), first))
    if (last < region.last) report.push(`[Changed lines continue to ${region.last}; read for their tags.]`)
  }
  return report.join('\n')
}

/** The 1-based lines of `after` that differ from `before`, or null when none do. */
export function changedRegion(
  before: readonly string[],
  after: readonly string[]
): { first: number; last: number } | null {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let beforeEnd = before.length
  let afterEnd = after.length
  while (afterEnd > start && beforeEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  if (start === afterEnd && start === beforeEnd) return null
  // A pure deletion leaves nothing new; show where it happened.
  if (afterEnd === start) return { first: start + 1, last: start + 1 }
  return { first: start + 1, last: afterEnd }
}

/** A change to a file as ACP reports one: an edit call carrying its diff. */
function changeOf(
  context: GroveToolContext,
  path: string,
  file: FileText,
  lines: string[]
): Omit<ToolCallUpdate, 'toolCallId'> {
  let oldText: string | null = null
  if (file.exists) oldText = joinText(file.lines, file)
  let line = 1
  const region = changedRegion(file.lines, lines)
  if (region) line = region.first
  return {
    kind: 'edit',
    title: displayPath(context.workspaceRoot, path),
    content: [{ type: 'diff', path, oldText, newText: joinText(lines, file) }],
    locations: [{ path, line }]
  }
}
