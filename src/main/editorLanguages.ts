// The language servers the editor runs, for the language servers Grove runs.
//
// Agents' `lsp` tools go through Grove's own LspManager rather than through
// nvim, so they need to know which server serves a file and how to start it.
// The editor already knows: mason-lspconfig enables a server for every one
// Mason installed, with the command and filetypes nvim-lspconfig gives it. So
// rather than keeping a list of its own that drifts from the editor's, Grove
// asks the editor's profile, run headless (see GROVE_LSP_DUMP in init.lua), for
// those servers and for the filetype nvim gives each file extension. A file's
// language is then nvim's filetype, which is also the LSP language id nvim
// sends, so both sides name `.svelte` and `.tsx` the same way.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { CatalogEntry } from '../shared/types'
import type { HeadlessNvim } from './debug/mason'

/** A server the editor enables, as a command line and the filetypes it attaches to. */
export interface EditorLanguageServer {
  name: string
  command: string
  args: string[]
  filetypes: string[]
}

/** What the editor's profile says about languages. */
export interface EditorLanguages {
  servers: EditorLanguageServer[]
  /** nvim's filetype for each file extension it knows, without the dot. */
  extensions: Record<string, string>
}

export const NO_EDITOR_LANGUAGES: EditorLanguages = { servers: [], extensions: {} }

/** Catalog ids of the editor's servers carry this prefix, apart from Grove's own entries. */
export const EDITOR_SERVER_PREFIX = 'editor:'

const DUMP_TIMEOUT_MS = 60_000
/**
 * How long after a read a language with no server sends Grove to read again.
 * A server installed in the editor since is picked up on the next ask after
 * that, without each ask for a language nobody serves starting an nvim.
 */
const REREAD_AFTER_MISS_MS = 60_000

/** Reads the dump init.lua writes; anything malformed is left out rather than trusted. */
export function parseEditorLanguages(text: string): EditorLanguages {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return NO_EDITOR_LANGUAGES
  }
  if (!parsed || typeof parsed !== 'object') {
    return NO_EDITOR_LANGUAGES
  }
  const dump = parsed as { servers?: unknown; extensions?: unknown }
  return { servers: serversOf(dump.servers), extensions: extensionsOf(dump.extensions) }
}

function serversOf(value: unknown): EditorLanguageServer[] {
  if (!Array.isArray(value)) {
    return []
  }
  const servers: EditorLanguageServer[] = []
  for (const candidate of value) {
    const server = serverOf(candidate)
    if (server) {
      servers.push(server)
    }
  }
  return servers
}

function serverOf(candidate: unknown): EditorLanguageServer | null {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const entry = candidate as { name?: unknown; cmd?: unknown; filetypes?: unknown }
  const commandLine = stringsOf(entry.cmd)
  const filetypes = stringsOf(entry.filetypes)
  if (commandLine.length === 0 || filetypes.length === 0) {
    return null
  }
  let name = commandLine[0]
  if (typeof entry.name === 'string' && entry.name.length > 0) {
    name = entry.name
  }
  return { name, command: commandLine[0], args: commandLine.slice(1), filetypes }
}

// vim.json.encode writes an empty table as `[]`, so an empty map arrives as an array.
function extensionsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const extensions: Record<string, string> = {}
  for (const [extension, filetype] of Object.entries(value)) {
    if (typeof filetype === 'string') {
      extensions[extension] = filetype
    }
  }
  return extensions
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

/** The editor's servers as catalog entries, for the same choice Grove's own entries go through. */
export function editorServerEntries(languages: EditorLanguages): CatalogEntry[] {
  return languages.servers.map((server) => ({
    id: `${EDITOR_SERVER_PREFIX}${server.name}`,
    kind: 'lsp',
    name: server.name,
    description: 'Enabled in the editor',
    lsp: { command: server.command, args: server.args, languages: server.filetypes }
  }))
}

/** nvim's filetype for a path, or null when it has no extension nvim maps. */
export function filetypeOf(languages: EditorLanguages, path: string): string | null {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  const extension = name.slice(dot + 1)
  const exact = languages.extensions[extension]
  if (exact) {
    return exact
  }
  const lower = languages.extensions[extension.toLowerCase()]
  if (lower) {
    return lower
  }
  return null
}

/** Runs the editor's profile headless and reads what it reports about languages. */
export async function readEditorLanguages(nvim: HeadlessNvim): Promise<EditorLanguages> {
  const directory = await mkdtemp(join(tmpdir(), 'grove-lsp-'))
  const output = join(directory, 'languages.json')
  try {
    await runDump(nvim, output)
    return parseEditorLanguages(await readFile(output, 'utf8'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function runDump(nvim: HeadlessNvim, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(nvim.binary, ['--headless', ...nvim.args], {
      env: { ...nvim.env, GROVE_LSP_DUMP: output },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const printed: string[] = []
    const timeout = setTimeout(() => child.kill('SIGKILL'), DUMP_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => printed.push(chunk.toString()))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }
      const detail = printed.join('').trim().split('\n').slice(-5).join('\n')
      reject(new Error(`reading the editor's language servers failed (exit ${code}): ${detail}`))
    })
  })
}

/**
 * The editor's languages, read once and again when a language turns out to
 * have no server and the last read is old enough that one may have arrived.
 */
export class EditorLanguageCatalog {
  private reading: Promise<EditorLanguages> | null = null
  private readAt = 0

  constructor(
    private read: () => Promise<EditorLanguages>,
    private log: (line: string) => void,
    private now: () => number = () => Date.now()
  ) {}

  /** What the editor reported, reading it first if nothing has been read yet. */
  current(): Promise<EditorLanguages> {
    if (!this.reading) {
      this.reading = this.readNow()
    }
    return this.reading
  }

  /**
   * Called when a language had no server: reads again if the last read is old
   * enough, so a server installed since is found. Otherwise what was read.
   */
  async afterMiss(): Promise<EditorLanguages> {
    const current = await this.current()
    if (this.now() - this.readAt < REREAD_AFTER_MISS_MS) {
      return current
    }
    this.reading = this.readNow()
    return this.reading
  }

  // A failed read is reported and leaves Grove's own catalog to serve; it is
  // tried again on the next miss rather than retried in a loop.
  private async readNow(): Promise<EditorLanguages> {
    this.readAt = this.now()
    try {
      return await this.read()
    } catch (error) {
      this.log(`lsp: ${(error as Error).message}`)
      return NO_EDITOR_LANGUAGES
    }
  }
}
