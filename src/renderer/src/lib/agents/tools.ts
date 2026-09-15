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

/**
 * What the call says it is doing, in the model's own words.
 *
 * Tools that take a `description` beside their arguments — a shell call is the usual one — carry
 * the intent that the arguments alone do not, which is exactly what an approval hangs on.
 */
export function descriptionOf(input: unknown): string {
  const fields = asRecord(input)
  if (fields === null || typeof fields.description !== 'string') {
    return ''
  }
  return fields.description.trim()
}

export interface PathLabel {
  /** The directory the file sits in, workspace-relative when it is inside one. */
  directory: string
  name: string
}

// A label is only a path if it is a single token: a command or a sentence is not
// one, and neither is a glob, whose "name" would be a pattern rather than a file.
const SINGLE_TOKEN = /^[^\s*?<>|]+$/
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/

/**
 * Reads a header label as a file path, so a call about a file can lead with the
 * file name and leave the directory behind it.
 *
 * Returns null for labels that are not paths — those stay one plain string.
 */
export function pathLabelOf(label: string, root: string): PathLabel | null {
  const value = label.trim()
  if (value.length === 0 || !SINGLE_TOKEN.test(value)) {
    return null
  }
  if (!value.includes('/') && !EXTENSION.test(value)) {
    return null
  }

  const relative = relativeTo(value, root)
  const cut = relative.lastIndexOf('/')
  if (cut < 0) {
    return { directory: '', name: relative }
  }
  return { directory: relative.slice(0, cut + 1), name: relative.slice(cut + 1) }
}

/**
 * The file a call is about, or null when it is not about one.
 *
 * Both the clickable header and follow mode ask this. Whatever a harness named its arguments —
 * `path`, `file_path`, something else entirely — a call whose header label reads as a path is a
 * call about that file, so nothing here has to know any tool's schema.
 */
export function fileOfCall(
  display: ToolDisplay | undefined,
  input: unknown,
  root: string
): string | null {
  // However single-token it looks, a command line is not a path.
  if (inputViewOf(display) === 'command') {
    return null
  }
  const label = labelFor(display, input)
  if (pathLabelOf(label, root) === null) {
    return null
  }
  return label.trim()
}

/** Paths inside the workspace read better without the part every row shares. */
function relativeTo(path: string, root: string): string {
  if (root.length === 0 || !path.startsWith(`${root}/`)) {
    return path
  }
  return path.slice(root.length + 1)
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

/**
 * The first field worth reading in the header. Lists count: a call whose only
 * argument is a set of files reads as those files rather than as nothing.
 */
function firstScalar(fields: Record<string, unknown>): string {
  for (const value of Object.values(fields)) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
    }
    if (Array.isArray(value) && value.length > 0) {
      return stringOf(value)
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
  if (Array.isArray(value)) {
    return value
      .map(entryLabel)
      .filter((text) => text.length > 0)
      .join(', ')
  }
  return String(value)
}

/**
 * One entry of a list-shaped field, for a header line.
 *
 * A call that takes several files — grove's own `open_files`, an edit batch —
 * reads as the files it names, not as `[object Object]`.
 */
function entryLabel(entry: unknown): string {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return String(entry)
  }
  const fields = asRecord(entry)
  if (fields === null) {
    return ''
  }
  if (typeof fields.path === 'string') {
    return fields.path
  }
  return firstScalar(fields)
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
