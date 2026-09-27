// What "Fix with agent" sends: a problem the user ran into, written up so the
// agent has the error, where it happened and the code around it without being
// told any of it by hand. Pure, so the wording can be tested.

import type { UserContentBlock } from './types'

/** One diagnostic as the agent reads it. Lines and columns are 1-based. */
export interface FixDiagnostic {
  line: number
  column: number
  severity: string
  message: string
  source?: string
}

/** A slice of a file around a problem. Lines are 1-based and inclusive. */
export interface CodeSlice {
  startLine: number
  endLine: number
  text: string
}

/** A problem to hand to an agent: diagnostics in a file, or a command that failed. */
export type FixProblem =
  | {
      kind: 'diagnostic'
      /** Relative to the worktree. */
      path: string
      diagnostics: FixDiagnostic[]
      code: CodeSlice | null
    }
  | {
      kind: 'command'
      command: string
      exitCode: number
      output: string
    }

/** Lines of context kept either side of a diagnostic. */
export const CONTEXT_RADIUS = 10

/** Vim's diagnostic severities (1–4) as words. */
const SEVERITY_NAMES: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint'
}

/** The word for a vim.diagnostic severity. */
export function severityName(severity: number): string {
  const name = SEVERITY_NAMES[severity]
  if (!name) {
    return 'hint'
  }
  return name
}

/** The lines of a file around a 1-based line, clamped to the file. */
export function surroundingCode(content: string, line: number, radius = CONTEXT_RADIUS): CodeSlice {
  const lines = content.split('\n')
  // A file's closing newline ends its last line rather than starting another.
  if (content.endsWith('\n')) {
    lines.pop()
  }
  const startLine = Math.max(1, line - radius)
  const endLine = Math.min(lines.length, line + radius)
  return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') }
}

/** The message an agent receives for a problem. */
export function fixMessage(problem: FixProblem): UserContentBlock[] {
  if (problem.kind === 'command') {
    return [{ type: 'text', text: commandText(problem.command, problem.exitCode, problem.output) }]
  }
  const blocks: UserContentBlock[] = [
    { type: 'text', text: diagnosticText(problem.path, problem.diagnostics) }
  ]
  if (problem.code) {
    blocks.push({ type: 'file', path: problem.path, ...problem.code })
  }
  return blocks
}

/** The request for a file's diagnostics, each listed at its position. */
function diagnosticText(path: string, diagnostics: FixDiagnostic[]): string {
  const listed = diagnostics.map((diagnostic) => `- ${describeDiagnostic(path, diagnostic)}`)
  let opening = `Fix the problem reported in ${path}:`
  if (diagnostics.length > 1) {
    opening = `Fix the problems reported in ${path}:`
  }
  return [opening, '', ...listed].join('\n')
}

/** One diagnostic as `path:line:col severity (source): message`. */
function describeDiagnostic(path: string, diagnostic: FixDiagnostic): string {
  let label = diagnostic.severity
  if (diagnostic.source) {
    label = `${diagnostic.severity} (${diagnostic.source})`
  }
  return `${path}:${diagnostic.line}:${diagnostic.column} ${label}: ${diagnostic.message}`
}

/** The request for a failed command, with what it printed. */
function commandText(command: string, exitCode: number, output: string): string {
  const lines = [
    `This command failed in my terminal with exit code ${exitCode}. Find out why and fix it.`,
    '',
    fenced(`$ ${command}\n${output}`.trimEnd(), 'console')
  ]
  return lines.join('\n')
}

/** Text in a code fence longer than any run of backticks inside it. */
export function fenced(text: string, language = ''): string {
  let longestRun = 0
  for (const run of text.match(/`+/g) || []) {
    longestRun = Math.max(longestRun, run.length)
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${language}\n${text}\n${fence}`
}
