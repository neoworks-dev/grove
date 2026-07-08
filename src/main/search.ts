// Content search via ripgrep (bundled @vscode/ripgrep). Streams `--json` match
// events, parsed into a normalized shape. node_modules/.git are excluded. The
// parser is pure (testable); the spawn wrapper streams matches to a callback.

import { spawn } from 'child_process'
import { rgPath } from '@vscode/ripgrep'
import type { SearchMatch } from '../shared/types'

export type { SearchMatch }

export interface SearchHandle {
  cancel: () => void
}

// Parse one ripgrep `--json` stdout line into a match (or null for other event
// types / malformed input).
export function parseRgMatch(line: string): SearchMatch | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let event: {
    type?: string
    data?: {
      path?: { text?: string }
      lines?: { text?: string }
      line_number?: number
      submatches?: { start?: number }[]
    }
  }
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (event.type !== 'match' || !event.data) return null
  const file = event.data.path?.text
  if (!file) return null
  return {
    file,
    line: event.data.line_number || 0,
    column: event.data.submatches?.[0]?.start || 0,
    text: (event.data.lines?.text || '').replace(/\r?\n$/, '')
  }
}

export function ripgrepSearch(
  root: string,
  query: string,
  onMatch: (match: SearchMatch) => void,
  onDone: () => void
): SearchHandle {
  const child = spawn(
    rgPath,
    [
      '--json',
      '--smart-case',
      '--max-count',
      '200',
      '--glob',
      '!node_modules',
      '--glob',
      '!.git',
      '--',
      query
    ],
    { cwd: root }
  )

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const match = parseRgMatch(line)
      if (match) onMatch(match)
      newline = buffer.indexOf('\n')
    }
  })
  child.on('close', () => onDone())
  child.on('error', () => onDone())

  return {
    cancel: () => {
      child.kill()
    }
  }
}
