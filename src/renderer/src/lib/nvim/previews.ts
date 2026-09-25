// The previews nvim hands to grove instead of drawing them itself: docs (hover,
// signature help, Inspect, plugin previews) as markdown with code nvim already
// highlighted, and a line's diagnostics with the quick fixes the servers offer.
// Each carries the colours of nvim's highlight groups, so grove draws it the
// way nvim's float would look. The bundled config sends `grove_preview`,
// `grove_preview_fixes`, `grove_preview_focus` and `grove_preview_close`; this
// reads those payloads. Kept free of the DOM so the parsing can be tested.

export interface PreviewDiagnostic {
  // vim.diagnostic.severity: 1 error, 2 warning, 3 info, 4 hint.
  severity: number
  message: string
  source: string | null
  code: string | null
}

// Colours (hex) of the nvim highlight groups a preview is drawn with. Any may
// be missing when the colorscheme leaves the group unset.
export interface PreviewTheme {
  fg?: string
  bg?: string
  heading?: string
  strong?: string
  raw?: string
  link?: string
  quote?: string
  dim?: string
  error?: string
  warn?: string
  info?: string
  hint?: string
}

// A stretch of a code line in one of nvim's highlight groups.
export interface StyledRun {
  text: string
  fg?: string
  bold: boolean
  italic: boolean
  underline: boolean
}

export type DocBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'code'; lines: StyledRun[][] }

interface PreviewBase {
  id: number
  // The cursor's screen cell, 0-based: the popover sits against this line.
  row: number
  col: number
  theme: PreviewTheme
}

export interface DocPreview extends PreviewBase {
  kind: 'doc'
  blocks: DocBlock[]
}

export interface DiagnosticsPreview extends PreviewBase {
  kind: 'diagnostics'
  diagnostics: PreviewDiagnostic[]
  // Null until every server has answered the quick-fix request.
  fixes: string[] | null
}

export type NvimPreview = DocPreview | DiagnosticsPreview

/** A plain object, or null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A string field, or null when missing or of another type. */
function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  return value
}

/** One diagnostic entry, or null when it has no message. */
function parseDiagnostic(value: unknown): PreviewDiagnostic | null {
  const record = asRecord(value)
  if (record === null) return null
  const message = stringField(record, 'message')
  if (message === null) return null
  let severity = 1
  if (typeof record.severity === 'number') severity = record.severity
  return {
    severity,
    message,
    source: stringField(record, 'source'),
    code: stringField(record, 'code')
  }
}

/** The diagnostics of a payload, dropping malformed entries. */
function parseDiagnostics(value: unknown): PreviewDiagnostic[] {
  if (!Array.isArray(value)) return []
  const diagnostics: PreviewDiagnostic[] = []
  for (const entry of value) {
    const diagnostic = parseDiagnostic(entry)
    if (diagnostic !== null) diagnostics.push(diagnostic)
  }
  return diagnostics
}

const THEME_KEYS = [
  'fg',
  'bg',
  'heading',
  'strong',
  'raw',
  'link',
  'quote',
  'dim',
  'error',
  'warn',
  'info',
  'hint'
] as const

/** The theme's colours that are well-formed hex. */
function parseTheme(value: unknown): PreviewTheme {
  const record = asRecord(value)
  const theme: PreviewTheme = {}
  if (record === null) return theme
  for (const key of THEME_KEYS) {
    const colour = stringField(record, key)
    if (colour !== null && /^#[0-9a-f]{6}$/i.test(colour)) theme[key] = colour
  }
  return theme
}

/** One styled run, or null without text. */
function parseRun(value: unknown): StyledRun | null {
  const record = asRecord(value)
  if (record === null) return null
  const text = stringField(record, 'text')
  if (text === null) return null
  const run: StyledRun = {
    text,
    bold: record.bold === true,
    italic: record.italic === true,
    underline: record.underline === true
  }
  const colour = stringField(record, 'fg')
  if (colour !== null && /^#[0-9a-f]{6}$/i.test(colour)) run.fg = colour
  return run
}

/** A code block's lines; an empty line is an empty list of runs. */
function parseCodeLines(value: unknown): StyledRun[][] {
  if (!Array.isArray(value)) return []
  return value.map((line) => {
    if (!Array.isArray(line)) return []
    return line.map(parseRun).filter((run): run is StyledRun => run !== null)
  })
}

/** One block of a doc preview, or null when malformed. */
function parseBlock(value: unknown): DocBlock | null {
  const record = asRecord(value)
  if (record === null) return null
  if (record.kind === 'code') return { kind: 'code', lines: parseCodeLines(record.lines) }
  const text = stringField(record, 'text')
  if (text === null) return null
  if (record.kind === 'markdown') return { kind: 'markdown', text }
  if (record.kind === 'text') return { kind: 'text', text }
  return null
}

/** A doc preview's blocks, without malformed or blank ones. */
function parseBlocks(value: unknown): DocBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: DocBlock[] = []
  for (const entry of value) {
    const block = parseBlock(entry)
    if (block === null) continue
    if (block.kind !== 'code' && block.text.trim() === '') continue
    if (block.kind === 'code' && block.lines.length === 0) continue
    blocks.push(block)
  }
  return blocks
}

/** A `grove_preview` payload, or null when it can't be shown. */
export function parsePreview(payload: unknown): NvimPreview | null {
  const record = asRecord(payload)
  if (record === null) return null
  if (typeof record.id !== 'number' || typeof record.row !== 'number') return null
  if (typeof record.col !== 'number') return null
  const base = { id: record.id, row: record.row, col: record.col, theme: parseTheme(record.theme) }
  if (record.kind === 'doc') {
    const blocks = parseBlocks(record.blocks)
    if (blocks.length === 0) return null
    return { ...base, kind: 'doc', blocks }
  }
  if (record.kind !== 'diagnostics') return null
  const diagnostics = parseDiagnostics(record.diagnostics)
  if (diagnostics.length === 0) return null
  return { ...base, kind: 'diagnostics', diagnostics, fixes: null }
}

/**
 * The preview with the quick fixes of a `grove_preview_fixes` payload, or the
 * preview unchanged when the payload is for another one.
 */
export function withFixes(preview: NvimPreview, payload: unknown): NvimPreview {
  const record = asRecord(payload)
  if (record === null || record.id !== preview.id) return preview
  if (preview.kind !== 'diagnostics') return preview
  let fixes: string[] = []
  if (Array.isArray(record.fixes)) {
    fixes = record.fixes.filter((title): title is string => typeof title === 'string')
  }
  return { ...preview, fixes }
}

/** Whether a `grove_preview_close` or `grove_preview_focus` payload is about this preview. */
export function isAboutPreview(preview: NvimPreview, payload: unknown): boolean {
  const record = asRecord(payload)
  if (record === null) return false
  return record.id === preview.id
}

export interface PopoverPlacement {
  left: number
  top: number
  // Above the line when there wasn't room below it.
  above: boolean
}

/**
 * Where the popover goes, in pixels within the pane: under the cursor's line,
 * or over it when the space below is too short and above is roomier; shifted
 * left to stay inside the pane.
 */
export function placePopover(
  anchor: { left: number; top: number; lineHeight: number },
  popover: { width: number; height: number },
  pane: { width: number; height: number },
  gap: number
): PopoverPlacement {
  const below = anchor.top + anchor.lineHeight + gap
  const spaceBelow = pane.height - below
  const spaceAbove = anchor.top - gap
  const above = popover.height > spaceBelow && spaceAbove > spaceBelow
  let top = below
  if (above) top = Math.max(0, anchor.top - gap - popover.height)
  const left = Math.max(0, Math.min(anchor.left, pane.width - popover.width))
  return { left, top, above }
}
