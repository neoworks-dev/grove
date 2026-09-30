// The language servers grove already runs for the editor, offered to grove
// mode's agent.
//
// One tool with an action rather than one per request: every tool costs its
// description on every turn, and these share their arguments. A position is a
// line and the symbol on it, since a model counts columns badly and names the
// thing it means well.

import { pathToFileURL, fileURLToPath } from 'url'
import type { DocumentSymbol, Location, SymbolInformation, WorkspaceSymbol } from 'vscode-languageserver-protocol'
import type { LspDiagnostic, LspPosition } from '../../../shared/types'
import { detectLanguage } from '../../git'
import type { LspManager } from '../../lsp'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'
import {
  displayPath,
  joinText,
  locate,
  resolvePath,
  type WorkspaceFiles,
  type WorktreeLocation
} from './workspaceFiles'

/** The part of the language server manager the tool uses. */
export type AgentLanguages = Pick<
  LspManager,
  | 'sync'
  | 'diagnosticsAfter'
  | 'diagnosticsUnder'
  | 'hover'
  | 'definition'
  | 'references'
  | 'documentSymbols'
  | 'workspaceSymbols'
>

/** How long to wait for a server to publish diagnostics after a sync. */
const DIAGNOSTICS_WAIT_MS = 3000
const MAX_LOCATIONS = 50
const MAX_DIAGNOSTICS = 100

const SEVERITIES: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

const SYMBOL_KINDS: Record<number, string> = {
  2: 'module',
  3: 'namespace',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  22: 'enum member',
  23: 'struct',
  26: 'type parameter'
}

/** A file synced to its language server, ready to be asked about. */
interface Target {
  path: string
  uri: string
  language: string
  worktree: WorktreeLocation
  lines: string[]
}

export function lspTool(
  languages: AgentLanguages,
  files: WorkspaceFiles,
  worktrees: () => WorktreeLocation[]
): GroveTool {
  return {
    name: 'lsp',
    summary: 'Ask the language server',
    promptGuidelines: ['Check lsp diagnostics on the files you changed'],
    description: [
      'Ask the language server about code.',
      'diagnostics: errors and warnings for path (after an edit, to check it), or for every file the server has reported on when path is left out.',
      'hover: type and docs of the symbol at path, line. definition, references: where it is defined or used.',
      'symbols: the outline of path, or with query, matching symbols across the workspace.',
      'A position is path, line (a number or a LINE#ID tag) and symbol, the name on that line you mean.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['diagnostics', 'hover', 'definition', 'references', 'symbols']
        },
        path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
        line: { type: ['integer', 'string'], description: 'Line number or LINE#ID tag.' },
        symbol: { type: 'string', description: 'The name on that line to ask about.' },
        query: { type: 'string', description: 'For symbols: the name to search the workspace for.' }
      },
      required: ['action'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{action} {symbol|query|path}', input: 'hidden', result: 'text' },

    async execute(input, context) {
      const tool = new LanguageQuery(languages, files, worktrees, context)
      try {
        return await tool.run(input)
      } catch (cause) {
        return { content: (cause as Error).message, isError: true }
      }
    }
  }
}

/** One call of the tool. */
class LanguageQuery {
  constructor(
    private languages: AgentLanguages,
    private files: WorkspaceFiles,
    private worktrees: () => WorktreeLocation[],
    private context: GroveToolContext
  ) {}

  async run(input: Record<string, unknown>): Promise<GroveToolResult> {
    const action = String(input.action)
    if (action === 'diagnostics') return this.diagnostics(input)
    if (action === 'symbols') return this.symbols(input)
    if (action === 'hover') return this.hover(input)
    if (action === 'definition' || action === 'references') return this.locations(action, input)
    return { content: `Unknown action "${action}".`, isError: true }
  }

  private async diagnostics(input: Record<string, unknown>): Promise<GroveToolResult> {
    if (typeof input.path !== 'string') return this.knownDiagnostics()
    const since = Date.now()
    const target = await this.target(input.path)
    const diagnostics = await this.languages.diagnosticsAfter(target.uri, since, DIAGNOSTICS_WAIT_MS)
    if (diagnostics === null) return { content: 'The language server has not reported on this file.' }
    if (diagnostics.length === 0) return { content: 'No diagnostics.' }
    return { content: diagnosticLines(target.path, diagnostics).join('\n') }
  }

  /** Every file's diagnostics the servers have published, inside the workspace. */
  private knownDiagnostics(): GroveToolResult {
    const root = pathToFileURL(this.context.workspaceRoot).toString()
    const lines: string[] = []
    for (const [uri, diagnostics] of this.languages.diagnosticsUnder(root)) {
      const path = displayPath(this.context.workspaceRoot, fileURLToPath(uri))
      lines.push(...diagnosticLines(path, diagnostics))
    }
    if (lines.length === 0) return { content: 'No diagnostics reported.' }
    if (lines.length > MAX_DIAGNOSTICS) {
      const more = lines.length - MAX_DIAGNOSTICS
      return { content: [...lines.slice(0, MAX_DIAGNOSTICS), `[${more} more.]`].join('\n') }
    }
    return { content: lines.join('\n') }
  }

  private async hover(input: Record<string, unknown>): Promise<GroveToolResult> {
    const target = await this.target(input.path)
    const position = positionOf(target, input)
    const text = await this.languages.hover(target.worktree.id, target.language, target.uri, position)
    if (!text) return { content: 'Nothing known about that position.' }
    return { content: text }
  }

  private async locations(
    action: 'definition' | 'references',
    input: Record<string, unknown>
  ): Promise<GroveToolResult> {
    const target = await this.target(input.path)
    const position = positionOf(target, input)
    const found = await this.languages[action](target.worktree.id, target.language, target.uri, position)
    if (found.length === 0) return { content: `No ${action} found.` }
    const lines = await this.locationLines(found.slice(0, MAX_LOCATIONS))
    if (found.length > MAX_LOCATIONS) lines.push(`[${found.length - MAX_LOCATIONS} more.]`)
    return { content: lines.join('\n') }
  }

  private async symbols(input: Record<string, unknown>): Promise<GroveToolResult> {
    if (typeof input.query === 'string') return this.workspaceSymbols(input.query, input.path)
    const target = await this.target(input.path)
    const symbols = await this.languages.documentSymbols(target.worktree.id, target.language, target.uri)
    if (symbols.length === 0) return { content: 'No symbols.' }
    return { content: outlineLines(symbols, 0).join('\n') }
  }

  private async workspaceSymbols(query: string, path: unknown): Promise<GroveToolResult> {
    // A server only starts once a file of its language is opened; a path
    // names which one to start when none runs yet.
    if (typeof path === 'string') await this.target(path)
    const worktree = this.worktreeOf(this.context.workspaceRoot)
    const symbols = await this.languages.workspaceSymbols(worktree.id, query)
    if (symbols.length === 0) {
      return { content: 'No symbols found. Pass a path of the language to start its server.' }
    }
    const lines = symbols.slice(0, MAX_LOCATIONS).map((symbol) => this.workspaceSymbolLine(symbol))
    if (symbols.length > MAX_LOCATIONS) lines.push(`[${symbols.length - MAX_LOCATIONS} more.]`)
    return { content: lines.join('\n') }
  }

  // ── Targets and positions ───────────────────────────────────────

  /** The file at `path`, synced to its language server from what the agent would read. */
  private async target(path: unknown): Promise<Target> {
    if (typeof path !== 'string' || path.length === 0) throw new Error('This action needs a path.')
    const absolutePath = resolvePath(this.context.workspaceRoot, path)
    const worktree = this.worktreeOf(absolutePath)
    const file = await this.files.read(absolutePath)
    if (!file.exists) throw new Error(`${path} does not exist.`)
    const language = detectLanguage(absolutePath)
    const uri = pathToFileURL(absolutePath).toString()
    const text = joinText(file.lines, file)
    const handled = await this.languages.sync(worktree.id, worktree.path, language, uri, text)
    if (!handled) throw new Error(`No language server is installed for ${language} files.`)
    return { path: displayPath(this.context.workspaceRoot, absolutePath), uri, language, worktree, lines: file.lines }
  }

  private worktreeOf(absolutePath: string): WorktreeLocation {
    const located = locate(this.worktrees(), absolutePath)
    if (!located) throw new Error('Language servers only run for files inside a worktree.')
    return located.worktree
  }

  // ── Output ──────────────────────────────────────────────────────

  private async locationLines(locations: Location[]): Promise<string[]> {
    const texts = new Map<string, string[]>()
    const lines: string[] = []
    for (const location of locations) {
      const absolutePath = fileURLToPath(location.uri)
      let fileLines = texts.get(absolutePath)
      if (!fileLines) {
        fileLines = await this.linesOf(absolutePath)
        texts.set(absolutePath, fileLines)
      }
      const line = location.range.start.line
      const text = (fileLines[line] ?? '').trim()
      const path = displayPath(this.context.workspaceRoot, absolutePath)
      lines.push(`${path}:${line + 1}  ${text}`)
    }
    return lines
  }

  /** A file's lines, or none when it cannot be read. */
  private async linesOf(absolutePath: string): Promise<string[]> {
    try {
      return (await this.files.read(absolutePath)).lines
    } catch {
      return []
    }
  }

  private workspaceSymbolLine(symbol: SymbolInformation | WorkspaceSymbol): string {
    const path = displayPath(this.context.workspaceRoot, fileURLToPath(symbol.location.uri))
    let where = path
    if ('range' in symbol.location) where = `${path}:${symbol.location.range.start.line + 1}`
    return `${symbol.name}  ${kindOf(symbol.kind)}  ${where}`
  }
}

/**
 * An LSP position from a line and the symbol on it. Without a symbol, the
 * line's first non-blank character.
 */
export function positionOf(target: { lines: string[] }, input: Record<string, unknown>): LspPosition {
  const line = lineNumberOf(input.line)
  const text = target.lines[line - 1]
  if (text === undefined) throw new Error(`Line ${line} does not exist (file has ${target.lines.length} lines).`)
  if (typeof input.symbol !== 'string' || input.symbol.length === 0) {
    return { line: line - 1, character: Math.max(0, text.search(/\S/)) }
  }
  const character = symbolColumn(text, input.symbol)
  if (character < 0) throw new Error(`"${input.symbol}" is not on line ${line}: ${text.trim()}`)
  return { line: line - 1, character }
}

/** Where a name starts on a line, preferring a whole-word match. */
function symbolColumn(text: string, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(text)
  if (word) return word.index
  return text.indexOf(symbol)
}

function lineNumberOf(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  if (typeof value === 'string') {
    const leading = /^\s*(\d+)/.exec(value)
    if (leading) return Number(leading[1])
  }
  throw new Error('This action needs a line: a number or a LINE#ID tag.')
}

function diagnosticLines(path: string, diagnostics: LspDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => {
    const start = diagnostic.range.start
    let severity = 'error'
    if (diagnostic.severity !== undefined) severity = SEVERITIES[diagnostic.severity] ?? 'info'
    let source = ''
    if (diagnostic.source) source = ` (${diagnostic.source})`
    return `${path}:${start.line + 1}:${start.character + 1} ${severity}: ${diagnostic.message}${source}`
  })
}

/** A document's symbols as an indented outline, one per line. */
function outlineLines(symbols: (DocumentSymbol | SymbolInformation)[], depth: number): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const symbol of symbols) {
    let line: number
    if ('range' in symbol) line = symbol.range.start.line
    else line = symbol.location.range.start.line
    lines.push(`${indent}${symbol.name}  ${kindOf(symbol.kind)}  ${line + 1}`)
    if ('children' in symbol && symbol.children) lines.push(...outlineLines(symbol.children, depth + 1))
  }
  return lines
}

function kindOf(kind: number): string {
  return SYMBOL_KINDS[kind] ?? 'symbol'
}
