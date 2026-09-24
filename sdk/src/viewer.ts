// For a plugin's file viewer page (`contributes.fileViewers`). The page runs
// in a sandboxed frame inside the editor pane, with no network and no Grove
// API; everything it gets arrives here. Import this from the page's own
// script, not from the worker — '@grove/plugin-sdk' itself only works there.
//
//   import { receiveFiles } from '@grove/plugin-sdk/viewer'
//   receiveFiles((file) => render(new Uint8Array(file.bytes)))

import type { FileViewerMessage, FileViewerTheme } from './protocol'

export type { FileViewerTheme } from './protocol'

/** The file a viewer page is showing. */
export interface ViewerFile {
  path: string
  name: string
  extension: string
  bytes: ArrayBuffer
  theme: FileViewerTheme
}

export interface ViewerHandlers {
  // The theme changed while the page was open.
  onTheme?: (theme: FileViewerTheme) => void
  // Grove could not read the file (a denied permission, a vanished file).
  onError?: (message: string) => void
}

/**
 * Calls `onFile` with the file this page shows, and again each time it
 * changes on disk. Tells Grove the page is listening; returns the inverse.
 */
export function receiveFiles(
  onFile: (file: ViewerFile) => void,
  handlers: ViewerHandlers = {}
): () => void {
  const listener = (event: MessageEvent): void => {
    // Only the frame's parent is Grove; anything else is not a message for us.
    if (event.source !== window.parent) return
    handleMessage(event.data as FileViewerMessage, onFile, handlers)
  }
  window.addEventListener('message', listener)
  const ready: FileViewerMessage = { type: 'grove.viewer.ready' }
  window.parent.postMessage(ready, '*')
  return () => window.removeEventListener('message', listener)
}

/** Routes one message from Grove to the handler it is for. */
function handleMessage(
  message: FileViewerMessage,
  onFile: (file: ViewerFile) => void,
  handlers: ViewerHandlers
): void {
  if (message.type === 'grove.viewer.file') {
    onFile({
      path: message.path,
      name: message.name,
      extension: message.extension,
      bytes: message.bytes,
      theme: message.theme
    })
    return
  }
  if (message.type === 'grove.viewer.theme') {
    handlers.onTheme?.(message.theme)
    return
  }
  if (message.type === 'grove.viewer.error') handlers.onError?.(message.message)
}
