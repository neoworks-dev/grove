// Code is rendered through markdown fences, so a language id here is a label
// rather than a grammar to load.
/**
 * What a tool call looks like at a glance.
 *
 * Every call collapses to one header line, because a transcript is mostly tool calls and reading
 * `{"path": "src/app.ts"}` twenty times is worse than reading `read  src/app.ts`.
 */

import type { ToolDisplay, ToolInputView, ToolResultView } from './types'

const EXTENSIONS: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'svelte',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

export function languageOfPath(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === undefined) {
    return undefined
  }
  return EXTENSIONS[extension]
}

const FIELD = /\{([^}]+)\}/g

/**
 * A one-line description of what the call is about, for the collapsed header.
 *
 * The template comes from the tool itself, so a tool this renderer has never heard of gets the
 * same treatment as a builtin. Without one, fall back to whatever reads best: a path, else the
 * first scalar in the input.
 */
export function labelFor(display: ToolDisplay | undefined, input: unknown): string {
  const fields = asRecord(input)
  if (fields === null) {
    return ''
  }
  if (display === undefined || display.label === undefined) {
    return defaultLabel(fields)
  }
  return display.label
    .replace(FIELD, (_match: string, names: string) => firstPresent(fields, names))
    .trim()
}

export function inputViewOf(display: ToolDisplay | undefined): ToolInputView {
  if (display === undefined || display.input === undefined) {
    return 'json'
  }
  return display.input
}

export function resultViewOf(display: ToolDisplay | undefined): ToolResultView {
  if (display === undefined || display.result === undefined) {
    return 'text'
  }
  return display.result
}

/** The input field a code view takes its syntax highlighting from, if the tool named one. */
export function languageOfInput(
  display: ToolDisplay | undefined,
  input: unknown
): string | undefined {
  if (display === undefined || display.languageFrom === undefined) {
    return undefined
  }
  const fields = asRecord(input)
  if (fields === null) {
    return undefined
  }
  return languageOfPath(stringOf(fields[display.languageFrom]))
}

function defaultLabel(fields: Record<string, unknown>): string {
  if (typeof fields.path === 'string') {
    return fields.path
  }
  return firstScalar(fields)
}

/** `{glob|path}` takes the first alternative the call actually set. */
function firstPresent(fields: Record<string, unknown>, names: string): string {
  for (const name of names.split('|')) {
    const value = fields[name.trim()]
    if (value !== undefined && value !== null) {
      return stringOf(value)
    }
  }
  return ''
}

function firstScalar(fields: Record<string, unknown>): string {
  for (const value of Object.values(fields)) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
    }
  }
  return ''
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

export function stringOf(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}

export interface EditReplacement {
  oldText: string
  newText: string
}

export function editsOf(input: unknown): EditReplacement[] {
  const fields = asRecord(input)
  if (fields === null || !Array.isArray(fields.edits)) {
    return []
  }

  const edits: EditReplacement[] = []
  for (const entry of fields.edits) {
    const record = asRecord(entry)
    if (
      record !== null &&
      typeof record.oldText === 'string' &&
      typeof record.newText === 'string'
    ) {
      edits.push({ oldText: record.oldText, newText: record.newText })
    }
  }
  return edits
}
