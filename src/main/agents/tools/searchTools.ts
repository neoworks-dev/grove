// Finding files and text in grove mode, through the ripgrep grove ships.
//
// Both answer in as few tokens as will do: paths relative to the workspace,
// matches grouped under the file they are in, and a cut-off that says so.

import { ripgrep } from '../../ripgrep'
import type { GroveTool } from '../harness'
import { displayPath, resolvePath } from './workspaceFiles'

const MAX_FILES = 200
const MAX_MATCHES = 100
/** Characters of a matching line shown before it is cut. */
const MAX_LINE_LENGTH = 300

/** find and grep. */
export function searchTools(): GroveTool[] {
  return [findTool(), grepTool()]
}

function findTool(): GroveTool {
  return {
    name: 'find',
    alwaysLoad: true,
    summary: 'Find files',
    description: `Find files by glob, e.g. "**/*.test.ts" or "src/**/store*". Respects .gitignore. Lists at most ${MAX_FILES} paths.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob the path must match, relative to the working directory.' },
        path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{pattern}', input: 'hidden', result: 'list' },

    async execute(input, context) {
      const root = searchRoot(context.workspaceRoot, input.path)
      const output = await ripgrep(context.workspaceRoot, root, ['--files', '--glob', String(input.pattern)])
      const paths = output.lines.filter((line) => line.length > 0).sort()
      if (paths.length === 0) return { content: 'No files match.' }
      const shown = paths.slice(0, MAX_FILES).map((path) => displayPath(context.workspaceRoot, path))
      if (paths.length > MAX_FILES) shown.push(`[${paths.length - MAX_FILES} more; narrow the pattern.]`)
      return { content: shown.join('\n') }
    }
  }
}

function grepTool(): GroveTool {
  return {
    name: 'grep',
    alwaysLoad: true,
    summary: 'Search file contents',
    description: `Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. Shows at most ${MAX_MATCHES} matching lines, grouped by file, as LINE:text.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to the working directory.'
        },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
        ignoreCase: { type: 'boolean', description: 'Match case-insensitively.' },
        context: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines of context around each match.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{pattern}', input: 'hidden', result: 'text' },

    async execute(input, context) {
      const root = searchRoot(context.workspaceRoot, input.path)
      const output = await ripgrep(context.workspaceRoot, root, grepArguments(input))
      if (output.failed) return { content: output.error, isError: true }
      const shown = groupedMatches(output.lines, (path) => displayPath(context.workspaceRoot, path))
      if (shown.length === 0) return { content: 'No matches.' }
      return { content: shown }
    }
  }
}

function grepArguments(input: Record<string, unknown>): string[] {
  const args = ['--line-number', '--with-filename', '--no-heading', '--color', 'never']
  args.push('--max-columns', String(MAX_LINE_LENGTH), '--max-columns-preview')
  if (input.ignoreCase === true) args.push('--ignore-case')
  if (typeof input.glob === 'string') args.push('--glob', input.glob)
  if (typeof input.context === 'number' && input.context > 0) {
    args.push('--context', String(input.context))
  }
  args.push('--regexp', String(input.pattern))
  return args
}

/**
 * ripgrep's `path:line:text` (and `path-line-text` for context) lines, grouped
 * under their file and cut after the match limit.
 */
export function groupedMatches(lines: string[], relative: (path: string) => string): string {
  const out: string[] = []
  let currentFile: string | null = null
  let matches = 0
  let total = 0
  for (const line of lines) {
    const parsed = parseGrepLine(line)
    if (!parsed) continue
    if (parsed.match) total += 1
    if (matches >= MAX_MATCHES) continue
    if (parsed.match) matches += 1
    if (parsed.file !== currentFile) {
      currentFile = parsed.file
      out.push(relative(parsed.file))
    }
    let separator = '-'
    if (parsed.match) separator = ':'
    out.push(`  ${parsed.line}${separator}${parsed.text}`)
  }
  if (total > matches) out.push(`[${total - matches} more matches; narrow the search.]`)
  return out.join('\n')
}

const MATCH_LINE = /^(.+?):(\d+):(.*)$/
const CONTEXT_LINE = /^(.+?)-(\d+)-(.*)$/

function parseGrepLine(
  line: string
): { file: string; line: number; text: string; match: boolean } | null {
  const match = MATCH_LINE.exec(line)
  if (match) return { file: match[1], line: Number(match[2]), text: match[3], match: true }
  const context = CONTEXT_LINE.exec(line)
  if (context) return { file: context[1], line: Number(context[2]), text: context[3], match: false }
  return null
}

function searchRoot(workspaceRoot: string, path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) return workspaceRoot
  return resolvePath(workspaceRoot, path)
}
