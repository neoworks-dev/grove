// Monaco setup + worker wiring for electron-vite (Vite `?worker` imports).
// Workers are bundled as separate chunks and loaded per language service.

import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { monacoThemeDefs } from './themes'

let configured = false

// Register one Monaco theme per app color theme so the editor background and
// foreground match the app chrome. Only hex colors are used (Monaco rejects
// rgba() theme values).
function defineThemes(): void {
  for (const def of monacoThemeDefs()) {
    monaco.editor.defineTheme(def.name, {
      base: def.base,
      inherit: true,
      rules: [],
      colors: {
        'editor.background': def.palette.bg,
        'editor.foreground': def.palette.text,
        'editorGutter.background': def.palette.bg,
        'editorLineNumber.foreground': def.palette.textFaint,
        'editorLineNumber.activeForeground': def.palette.textMuted,
        'editorWidget.background': def.palette.surface,
        'editorWidget.border': def.palette.border,
        'diffEditor.insertedTextBackground': '#4ade8022',
        'diffEditor.removedTextBackground': '#f8717122'
      }
    })
  }
}

export function setupMonaco(): typeof monaco {
  if (configured) return monaco
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }
  defineThemes()
  configured = true
  return monaco
}

export { monaco }
