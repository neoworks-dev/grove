// The previews nvim hands to grove instead of drawing them itself: hover docs,
// signature help, Inspect and plugin previews as text or markdown, and a line's
// diagnostics with the quick fixes the servers offer for them. The bundled
// config sends them as `grove_preview`, `grove_preview_fixes` and
// `grove_preview_close`; this reads those payloads. Kept free of the DOM so the
// parsing can be tested on its own.

export interface PreviewDiagnostic {
  // vim.diagnostic.severity: 1 error, 2 warning, 3 info, 4 hint.
  severity: number
  message: string
  source: string | null
  code: string | null
}

interface PreviewBase {
  id: number
  // The cursor's screen cell, 0-based: the popover sits against this line.
  row: number
  col: number
}

export interface TextPreview extends PreviewBase {
  kind: 'text' | 'markdown'
  text: string
}

export interface DiagnosticsPreview extends PreviewBase {
  kind: 'diagnostics'
  diagnostics: PreviewDiagnostic[]
  // Null until every server has answered the quick-fix request.
  fixes: string[] | null
}

export type NvimPreview = TextPreview | DiagnosticsPreview

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

/** A `grove_preview` payload, or null when it can't be shown. */
export function parsePreview(payload: unknown): NvimPreview | null {
  const record = asRecord(payload)
  if (record === null) return null
  if (typeof record.id !== 'number' || typeof record.row !== 'number') return null
  if (typeof record.col !== 'number') return null
  const base = { id: record.id, row: record.row, col: record.col }
  if (record.kind === 'diagnostics') {
    const diagnostics = parseDiagnostics(record.diagnostics)
    if (diagnostics.length === 0) return null
    return { ...base, kind: 'diagnostics', diagnostics, fixes: null }
  }
  const text = stringField(record, 'text')
  if (text === null || text.trim() === '') return null
  if (record.kind === 'markdown') return { ...base, kind: 'markdown', text }
  return { ...base, kind: 'text', text }
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

/** Whether a `grove_preview_close` payload ends this preview. */
export function closesPreview(preview: NvimPreview, payload: unknown): boolean {
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
