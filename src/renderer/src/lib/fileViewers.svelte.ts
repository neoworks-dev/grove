// Viewers for files nvim can't sensibly show as text. The editor pane keeps
// such a file in its tab strip like any other, but shows the registered viewer
// in nvim's place instead of :edit-ing its bytes. Images, video, PDFs and 3D
// models are core plugins registering here; a sandboxed plugin's viewer is a
// page of its own, registered here by the plugin host.
//
// Matched by extension alone, so a tab restored from disk or entered with `:e`
// finds the same viewer as a fresh open.

import { pickViewer, type FileViewer } from './fileViewer'

export type { FileViewer, FileViewerProps } from './fileViewer'

class FileViewerRegistry {
  viewers = $state.raw<FileViewer[]>([])

  /** Adds a viewer, replacing any with the same id; returns the inverse. */
  register(viewer: FileViewer): () => void {
    const others = this.viewers.filter((entry) => entry.id !== viewer.id)
    this.viewers = [...others, viewer]
    return () => {
      this.viewers = this.viewers.filter((entry) => entry !== viewer)
    }
  }

  /** The viewer a file opens in, or null when nvim should edit it as text. */
  viewerFor(path: string): FileViewer | null {
    return pickViewer(this.viewers, path)
  }
}

export const fileViewers = new FileViewerRegistry()
