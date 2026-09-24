// What a file viewer is, and which one a file opens in. Kept apart from the
// registry, which holds them in runes state, so the choice is testable.

import type { Component } from 'svelte'
import { extensionOf } from './fileUrl'

/** What every viewer is handed about the file it shows. */
export interface FileViewerProps {
  worktreeId: string
  // Absolute path of the file.
  path: string
  // A grove-file:// URL for its bytes, changed whenever the file is rewritten.
  src: string
  // Whatever the registration passed along; a plugin viewer's page lives here.
  options?: unknown
}

export interface FileViewer {
  id: string
  // Shown where a person picks between viewers, e.g. "Image".
  label: string
  // Lowercase, without the dot: ['png', 'jpg'].
  extensions: string[]
  // Fetched the first time a file opens in it, so heavy viewers (pdf.js,
  // three.js) cost nothing until then.
  load: () => Promise<{ default: Component<FileViewerProps> }>
  options?: unknown
  // Higher wins when two viewers claim an extension; ties go to the newest.
  priority?: number
}

/** The best of `viewers` for `path`: highest priority, then latest registered. */
export function pickViewer(viewers: readonly FileViewer[], path: string): FileViewer | null {
  const extension = extensionOf(path)
  if (extension === '') return null
  let best: FileViewer | null = null
  for (const viewer of viewers) {
    if (!viewer.extensions.includes(extension)) continue
    if (best === null || priorityOf(viewer) >= priorityOf(best)) best = viewer
  }
  return best
}

/** A viewer's priority, 0 when it gives none. */
function priorityOf(viewer: FileViewer): number {
  if (viewer.priority === undefined) return 0
  return viewer.priority
}
