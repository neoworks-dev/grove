// Apply LSP TextEdits / WorkspaceEdits to file contents. Pure string transforms
// so the editor can apply them to the live buffer and write the rest to disk.

import type { Position, TextEdit, WorkspaceEdit } from 'vscode-languageserver-types'
import { uriToPath } from './lspUri'

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function offsetOf(starts: number[], position: Position): number {
  const base = starts[Math.min(position.line, starts.length - 1)] ?? 0
  return base + position.character
}

// Apply edits to text. Edits are applied end-to-start so earlier offsets stay
// valid; overlapping edits are assumed non-conflicting (LSP guarantees this).
export function applyEditsToText(text: string, edits: TextEdit[]): string {
  const starts = lineStarts(text)
  const ordered = [...edits].sort(
    (a, b) => offsetOf(starts, b.range.start) - offsetOf(starts, a.range.start)
  )
  let result = text
  for (const edit of ordered) {
    const from = offsetOf(starts, edit.range.start)
    const to = offsetOf(starts, edit.range.end)
    result = result.slice(0, from) + edit.newText + result.slice(to)
  }
  return result
}

// Flatten a WorkspaceEdit (either `changes` map or `documentChanges`) into a
// per-file edit list keyed by absolute path.
export function workspaceEditToFiles(edit: WorkspaceEdit): { path: string; edits: TextEdit[] }[] {
  const files: { path: string; edits: TextEdit[] }[] = []
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      files.push({ path: uriToPath(uri), edits })
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ('textDocument' in change && 'edits' in change) {
        files.push({ path: uriToPath(change.textDocument.uri), edits: change.edits as TextEdit[] })
      }
    }
  }
  return files
}
