// Pure parser for the unified diff text returned by git:diffText, rendered as
// simple +/- rows in the intro pane's AGENTS.md showcase card.

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'context'
  text: string
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

// File-level header lines emitted by `git diff --no-index` over temp files.
function isFileHeader(line: string): boolean {
  if (line.startsWith('diff --git ')) return true
  if (line.startsWith('index ')) return true
  if (line.startsWith('--- ')) return true
  if (line.startsWith('+++ ')) return true
  if (line.startsWith('new file mode ')) return true
  if (line.startsWith('deleted file mode ')) return true
  if (line.startsWith('old mode ')) return true
  if (line.startsWith('new mode ')) return true
  return line.startsWith('\\ No newline')
}

export function parseUnifiedDiff(diffText: string): DiffRow[] {
  if (!diffText.trim()) return []
  const rows: DiffRow[] = []
  for (const line of diffText.split('\n')) {
    if (isFileHeader(line)) continue
    if (HUNK_HEADER.test(line)) {
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1) })
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1) })
      continue
    }
    if (line.startsWith(' ')) {
      rows.push({ kind: 'context', text: line.slice(1) })
    }
    // Anything else (trailing empty line etc.) is dropped.
  }
  return rows
}

// Quick +/- totals for the card header.
export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added += 1
    if (row.kind === 'del') removed += 1
  }
  return { added, removed }
}
