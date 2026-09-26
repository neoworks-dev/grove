// Putting things in front of the user.
//
// An answer about code lands better with the code on screen. `open_files` puts
// files in the editor; these go further — a marked range with a note beside it,
// a diff, an issue, any pane grove has — so the agent can point rather than
// describe. Each only asks: the renderer shows it when the user is looking at
// this session, and leaves the screen alone when they are not.

import type { PaneTypeInfo, ShowTarget } from '../../shared/agents'
import type { GroveTool, GroveToolContext, GroveToolResult } from './harness'

/** What the renderer can open, as far as the main process knows. */
export interface AgentScreen {
  paneTypes(): PaneTypeInfo[]
}

// Said in every result: whether it was shown depends on what the user is looking
// at, which the agent cannot see.
const SHOWN_IF_VIEWING = 'The user sees it if they are looking at this conversation.'

/** Every tool that shows the user something. */
export function showTools(screen: AgentScreen): GroveTool[] {
  return [highlightTool(), diffTool(), githubTool(), paneTool(screen)]
}

/** Asks for a target to be shown, and says so. */
function show(context: GroveToolContext, target: ShowTarget, what: string): GroveToolResult {
  context.show(target)
  return { content: `Showing ${what}. ${SHOWN_IF_VIEWING}` }
}

/** Marks a range of lines, with a note, in the editor. */
function highlightTool(): GroveTool {
  return {
    name: 'highlight_code',
    summary: 'Mark lines of a file for the user to look at.',
    description:
      'Open a file in the editor and mark a range of lines, with an optional note shown above ' +
      'them. Use it to point at the code your answer is about — the bug, the call site, the ' +
      'line you want a decision on. Marks stay until the user next sends a message; call it ' +
      'once per range to mark several.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or relative to the workspace root.' },
        startLine: { type: 'number', description: 'First line to mark, 1-based.' },
        endLine: { type: 'number', description: 'Last line to mark, inclusive. Defaults to startLine.' },
        note: { type: 'string', description: 'A short note shown above the marked lines.' }
      },
      required: ['path', 'startLine'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{path}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const path = textOf(input.path)
      const startLine = lineOf(input.startLine)
      if (!path || startLine === null) {
        return { content: 'Name a file and the line to start at.', isError: true }
      }
      let endLine = lineOf(input.endLine)
      if (endLine === null || endLine < startLine) endLine = startLine

      const target: ShowTarget = { kind: 'code', path, startLine, endLine }
      const note = textOf(input.note)
      if (note) target.note = note
      return show(context, target, `${path}:${startLine}-${endLine}`)
    }
  }
}

/** Opens the uncommitted changes, whole or for one file. */
function diffTool(): GroveTool {
  return {
    name: 'show_diff',
    summary: 'Show the user uncommitted changes.',
    description:
      "Show the worktree's uncommitted changes. With a path, that file opens beside its last " +
      'committed version; without one, the list of changed files opens. Use it when you want ' +
      'the user to look over what changed rather than take your word for it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional file, absolute or workspace-relative.' }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{path}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const path = textOf(input.path)
      if (!path) return show(context, { kind: 'diff' }, 'the changed files')
      return show(context, { kind: 'diff', path }, `the diff of ${path}`)
    }
  }
}

/** Opens an issue or pull request in the GitHub pane. */
function githubTool(): GroveTool {
  return {
    name: 'show_github_item',
    summary: 'Open an issue or pull request for the user.',
    description:
      "Open an issue or pull request of this repository in grove's GitHub pane: its thread, " +
      'labels, assignees and state. Use it when your answer is about one, instead of pasting ' +
      'its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'The issue or pull request number.' }
      },
      required: ['number'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '#{number}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const number = lineOf(input.number)
      if (number === null) return { content: 'Name the issue or pull request.', isError: true }
      return show(context, { kind: 'github', number }, `#${number}`)
    }
  }
}

/** Opens any pane the renderer has registered. */
function paneTool(screen: AgentScreen): GroveTool {
  return {
    name: 'open_pane',
    summary: 'Open one of grove’s panes for the user.',
    description:
      'Open a pane in grove — a terminal, the problems list, the git changes, the logs, the ' +
      'markdown preview, whatever grove has. Call it without `pane` to list them. Use it when ' +
      'what you want the user to see lives in a pane rather than in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', description: 'The pane id. Leave out to list them.' }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{pane}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const types = screen.paneTypes()
      const requested = textOf(input.pane)
      if (!requested) return { content: describePanes(types) }
      const type = types.find((entry) => entry.id === requested)
      if (!type) {
        return { content: `No pane "${requested}". ${describePanes(types)}`, isError: true }
      }
      return show(context, { kind: 'pane', pane: type.id }, `the ${type.title} pane`)
    }
  }
}

/** The panes there are, as the model reads them. */
function describePanes(types: PaneTypeInfo[]): string {
  if (types.length === 0) return 'grove has not reported its panes yet.'
  const lines = types.map((type) => `- ${type.id}: ${type.title}`)
  return ['Panes:', ...lines].join('\n')
}

/** Text a model wrote, or null when it wrote nothing. */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  return value.trim()
}

/** A positive whole number a model wrote, or null. */
function lineOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null
  return Math.floor(value)
}
