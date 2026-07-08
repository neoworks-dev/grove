// CodeMirror ↔ LSP client glue. Talks to the main-process LspManager over IPC to
// provide completion, hover, and diagnostics for the active file. Full-document
// sync; positions map between CM offsets and LSP line/character.

import { type Extension, type Text } from '@codemirror/state'
import { keymap, hoverTooltip } from '@codemirror/view'
import {
  autocompletion,
  completionKeymap,
  type CompletionSource
} from '@codemirror/autocomplete'
import { type Diagnostic } from '@codemirror/lint'
import type { LspDiagnostic, LspPosition } from '../../../shared/types'

export interface LspContext {
  worktreeId: string
  path: string
  uri: string
  language: string
}

// File extension → LSP languageId. Only languages an installed server declares
// actually do anything; this map is intentionally broad.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascriptreact', py: 'python', pyi: 'python', go: 'go', rs: 'rust',
  rb: 'ruby', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  lua: 'lua', html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml'
}

export function lspLanguageFor(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_BY_EXT[ext] || null
}

// URI helpers live in a dependency-free module; re-exported here for callers.
export { fileUri, uriToPath } from './lspUri'

export function offsetToPosition(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

export function positionToOffset(doc: Text, position: LspPosition): number {
  const lineNumber = Math.min(Math.max(position.line + 1, 1), doc.lines)
  const line = doc.line(lineNumber)
  return Math.min(line.from + position.character, line.to)
}

// LSP DiagnosticSeverity → CM lint severity.
function severityFor(severity?: number): Diagnostic['severity'] {
  if (severity === 1) return 'error'
  if (severity === 2) return 'warning'
  return 'info'
}

export function toCmDiagnostics(doc: Text, diagnostics: LspDiagnostic[]): Diagnostic[] {
  return diagnostics
    .map((diagnostic) => ({
      from: positionToOffset(doc, diagnostic.range.start),
      to: positionToOffset(doc, diagnostic.range.end),
      severity: severityFor(diagnostic.severity),
      source: diagnostic.source,
      message: diagnostic.message
    }))
    .filter((diagnostic) => diagnostic.from <= diagnostic.to)
}

function completionSource(context: LspContext): CompletionSource {
  return async (completion) => {
    const position = offsetToPosition(completion.state.doc, completion.pos)
    const items = await window.workbench.lsp
      .completion(context.worktreeId, context.language, context.uri, position)
      .catch(() => [])
    if (items.length === 0) return null
    const word = completion.matchBefore(/[\w$]*/)
    const from = word ? word.from : completion.pos
    return {
      from,
      options: items.map((item) => ({
        label: item.label,
        detail: item.detail,
        apply: item.insertText || item.label
      }))
    }
  }
}

function hover(context: LspContext): Extension {
  return hoverTooltip(async (view, pos) => {
    const position = offsetToPosition(view.state.doc, pos)
    const text = await window.workbench.lsp
      .hover(context.worktreeId, context.language, context.uri, position)
      .catch(() => null)
    if (!text) return null
    return {
      pos,
      create() {
        const dom = document.createElement('div')
        dom.className = 'cm-lsp-hover'
        dom.textContent = text
        return { dom }
      }
    }
  })
}

// The full LSP extension bundle for one file's editor (completion + hover).
// Diagnostics are applied separately via setDiagnostics on incoming events.
export function lspExtensions(context: LspContext): Extension {
  return [
    autocompletion({ override: [completionSource(context)] }),
    keymap.of(completionKeymap),
    hover(context)
  ]
}
