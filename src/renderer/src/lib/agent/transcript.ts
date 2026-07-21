// Transcript row model for the agent pane. Turns the flat OutputItem stream
// into renderable rows: tool results fold into their tool, and consecutive
// file-edit tools collapse into a single "edited N files" group. Kept pure and
// DOM-free so the grouping is unit-testable.

import type { OutputItem } from '../agentStream'

// File-editing tools whose consecutive calls collapse into one group.
export const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Task tools fold into the pinned checklist, not the transcript body.
export const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

export type ToolItem = Extract<OutputItem, { kind: 'tool' }>
export type ResultItem = Extract<OutputItem, { kind: 'tool-result' }>

// A tool call paired with its result (the result is nested inside the tool's
// own expand rather than shown as a separate row).
export interface RenderTool {
  item: ToolItem
  result: ResultItem | null
}

export type TranscriptRow =
  | { kind: 'item'; item: OutputItem }
  | { kind: 'tool'; tool: RenderTool }
  | { kind: 'edit-group'; key: string; tools: RenderTool[] }

// Map each tool's key to its result item (result keys are `result:<toolKey>`).
export function resultsByToolKey(items: OutputItem[]): Map<string, ResultItem> {
  const map = new Map<string, ResultItem>()
  for (const item of items) {
    if (item.kind === 'tool-result') map.set(item.key.replace(/^result:/, ''), item)
  }
  return map
}

// Build the row list. Results are consumed by their tool; runs of ≥2 tool
// calls become one group, a single tool stays a normal tool row.
export function buildTranscriptRows(
  visibleItems: OutputItem[],
  results: Map<string, ResultItem>
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let toolRun: RenderTool[] = []

  function flushTools(): void {
    if (toolRun.length === 0) return
    if (toolRun.length === 1) {
      rows.push({ kind: 'tool', tool: toolRun[0] })
    } else {
      rows.push({ kind: 'edit-group', key: toolRun[0].item.key, tools: toolRun })
    }
    toolRun = []
  }

  for (const item of visibleItems) {
    if (item.kind === 'tool-result') continue
    if (item.kind === 'tool' && !TASK_TOOLS.has(item.tool)) {
      toolRun.push({ item, result: results.get(item.key) || null })
      continue
    }
    flushTools()
    rows.push({ kind: 'item', item })
  }
  flushTools()
  return rows
}

// Count distinct files touched by the file-edit tools in a group.
export function changedFileCount(
  tools: RenderTool[],
  filePath: (input: Record<string, unknown>) => string | null
): number {
  const files = new Set<string>()
  for (const tool of tools) {
    if (!FILE_EDIT_TOOLS.has(tool.item.tool)) continue
    const path = filePath(tool.item.input)
    if (path) files.add(path)
  }
  return files.size
}

// Distinct tool names used in a group, in first-seen order.
export function toolNames(tools: RenderTool[]): string[] {
  const seen: string[] = []
  for (const tool of tools) {
    if (!seen.includes(tool.item.tool)) seen.push(tool.item.tool)
  }
  return seen
}

function lineCount(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return text.split('\n').length
}

// Approximate +/- line counts for one file-edit tool, from its input. Write
// counts its content as additions (no prior content is available here); Edit and
// MultiEdit count the replaced vs. inserted blocks.
export function editStats(
  tool: string,
  input: Record<string, unknown>
): { added: number; removed: number } {
  if (tool === 'Write') {
    return { added: lineCount(input.content), removed: 0 }
  }
  if (tool === 'Edit') {
    return { added: lineCount(input.new_string), removed: lineCount(input.old_string) }
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).reduce<{ added: number; removed: number }>(
      (acc, edit) => ({
        added: acc.added + lineCount(edit.new_string),
        removed: acc.removed + lineCount(edit.old_string)
      }),
      { added: 0, removed: 0 }
    )
  }
  return { added: 0, removed: 0 }
}

// One changed file in a group: its display label, an input for opening its diff,
// and aggregated +/- counts across every edit tool that touched it.
export interface ChangedFile {
  path: string
  label: string
  input: Record<string, unknown>
  added: number
  removed: number
}

// Distinct file-edit targets in a group, with aggregated +/- counts.
export function changedFiles(
  tools: RenderTool[],
  filePath: (input: Record<string, unknown>) => string | null,
  relativePath: (absPath: string) => string | null
): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>()
  for (const tool of tools) {
    if (!FILE_EDIT_TOOLS.has(tool.item.tool)) continue
    const path = filePath(tool.item.input)
    if (!path) continue
    const stats = editStats(tool.item.tool, tool.item.input)
    const existing = byPath.get(path)
    if (existing) {
      existing.added += stats.added
      existing.removed += stats.removed
      existing.input = tool.item.input
      continue
    }
    byPath.set(path, {
      path,
      label: relativePath(path) || path,
      input: tool.item.input,
      added: stats.added,
      removed: stats.removed
    })
  }
  return [...byPath.values()]
}

// The stable key for a row (used as the {#each} key and data-item-key anchor).
export function rowKey(row: TranscriptRow): string {
  if (row.kind === 'edit-group') return row.key
  if (row.kind === 'tool') return row.tool.item.key
  return row.item.key
}

// Full, untruncated detail for a tool card (the whole command or input JSON).
export function toolDetail(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  return JSON.stringify(input, null, 2)
}

// Collapsed label for a tool result: the first error line, or a size hint.
export function resultLabel(text: string, isError: boolean): string {
  if (isError) return text.split('\n')[0]
  return `result · ${text.length} chars`
}

// A user message split into plain text and @file-mention segments so mentions
// render as clickable badges. A mention is an `@` at a word boundary followed
// by a non-space path; trailing sentence punctuation is peeled back off.
export type UserSegment = { kind: 'text'; value: string } | { kind: 'mention'; path: string }

const TRAILING_PUNCTUATION = /[.,;)\]}!?]+$/

export function userSegments(text: string): UserSegment[] {
  const segments: UserSegment[] = []
  const pattern = /@[^\s@]+/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const before = match.index === 0 ? '' : text[match.index - 1]
    const atWordBoundary = before === '' || before === ' ' || before === '\n' || before === '('
    if (!atWordBoundary) continue

    let path = match[0].slice(1)
    let trailing = ''
    const trimmed = path.match(TRAILING_PUNCTUATION)
    if (trimmed) {
      trailing = trimmed[0]
      path = path.slice(0, -trailing.length)
    }
    if (!path) continue

    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({ kind: 'mention', path })
    if (trailing) segments.push({ kind: 'text', value: trailing })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) segments.push({ kind: 'text', value: text.slice(lastIndex) })
  return segments
}
