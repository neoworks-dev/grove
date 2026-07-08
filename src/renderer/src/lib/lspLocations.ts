// Present LSP location results (definition, references, implementation, …).
// One result jumps straight there; several open the canonical overlay with a
// source excerpt preview, so the user picks which occurrence to visit.

import type { Location } from 'vscode-languageserver-types'
import { overlays, type OverlayItem } from './overlays.svelte'
import { dialogs } from './dialogs.svelte'
import { store, openFileAtLine } from './store.svelte'
import { uriToPath } from './lspUri'

const PREVIEW_CONTEXT_LINES = 8

function relativeLabel(path: string): string {
  const root = store.selectedWorktree?.path
  if (root && path.startsWith(root)) return path.slice(root.length).replace(/^\//, '')
  return path
}

// Open a single location: focus its file at the target line (1-based).
export function openLocation(worktreeId: string, location: Location): void {
  const path = uriToPath(location.uri)
  openFileAtLine(worktreeId, path, location.range.start.line + 1)
}

async function previewFor(worktreeId: string, item: OverlayItem): Promise<
  { kind: 'excerpt'; file: string; lines: { n: number; text: string }[]; highlightLine: number } | null
> {
  const location = item.data as Location
  const path = uriToPath(location.uri)
  const content = await window.workbench.files.read(worktreeId, path).catch(() => null)
  if (content === null) return null
  const allLines = content.split('\n')
  const target = location.range.start.line
  const from = Math.max(0, target - PREVIEW_CONTEXT_LINES)
  const to = Math.min(allLines.length, target + PREVIEW_CONTEXT_LINES + 1)
  const lines = []
  for (let index = from; index < to; index++) {
    lines.push({ n: index + 1, text: allLines[index] })
  }
  return { kind: 'excerpt', file: path, lines, highlightLine: target + 1 }
}

function toItem(location: Location, index: number): OverlayItem {
  const path = uriToPath(location.uri)
  const line = location.range.start.line + 1
  return {
    id: `${location.uri}:${line}:${index}`,
    label: relativeLabel(path),
    icon: 'file:' + path,
    detail: `:${line}`,
    data: location
  }
}

// Show location results. Empty → a toast; single → jump; many → overlay picker.
export function showLocations(worktreeId: string, locations: Location[], title: string): void {
  if (locations.length === 0) {
    dialogs.notify({ level: 'info', message: `No ${title.toLowerCase()} found`, timeoutMs: 2000 })
    return
  }
  if (locations.length === 1) {
    openLocation(worktreeId, locations[0])
    return
  }
  const items = locations.map(toItem)
  overlays.show({
    id: 'lsp.locations',
    placeholder: `${title} — ${locations.length} results`,
    onQuery: (query, emit) => {
      const needle = query.trim().toLowerCase()
      const filtered = needle
        ? items.filter((item) => item.label.toLowerCase().includes(needle))
        : items
      emit(filtered, { replace: true })
    },
    onPreview: (item) => previewFor(worktreeId, item),
    onAccept: (picked) => {
      const location = picked[0]?.data as Location | undefined
      if (location) openLocation(worktreeId, location)
    }
  })
}
