declare module 'monaco-vim' {
  import type * as Monaco from 'monaco-editor'
  export function initVimMode(
    editor: Monaco.editor.IStandaloneCodeEditor,
    statusBar?: HTMLElement | null
  ): { dispose: () => void }
}
