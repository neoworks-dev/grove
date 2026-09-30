// Putting things in front of the user.
//
// An answer about code lands better with the code at hand, so the agent can
// point rather than describe. Code is pointed at, never opened: an answer that
// names four places used to open four files and mark each of them, which buried
// the editor. `show_locations` lists them as a card in the conversation, and the
// user opens the one they want. A diff, an issue or a pane is one thing, so
// those do open — when the user is looking at this session, and not otherwise.

import { randomUUID } from 'node:crypto'
import type {
  CodeLocation,
  LineAnnotation,
  PaneTypeInfo,
  ShowTarget,
  UiNode
} from '../../../shared/agents'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'
import { anchorLocations } from '../locationAnchor'

/** What the renderer can open, as far as the main process knows. */
export interface AgentScreen {
  paneTypes(): PaneTypeInfo[]
}

// Said in every result: whether it was shown depends on what the user is looking
// at, which the agent cannot see.
const SHOWN_IF_VIEWING = 'The user sees it if they are looking at this conversation.'

/** Every tool that shows the user something. */
export function showTools(screen: AgentScreen): GroveTool[] {
  return [locationsTool(), diffTool(), githubTool(), paneTool(screen)]
}

/** Asks for a target to be shown, and says so. */
function show(context: GroveToolContext, target: ShowTarget, what: string): GroveToolResult {
  context.show(target)
  return { content: `Showing ${what}. ${SHOWN_IF_VIEWING}` }
}

// More than this is a search result, not an answer; the card stops there.
const MAX_LOCATIONS = 20
const MAX_ANNOTATIONS = 8

// A note says what the user is looking at, not everything about it: two or
// three short sentences. Longer ones are cut, so the editor stays readable.
const MAX_NOTE_LENGTH = 240
// A step's title names it in a bar across the editor.
const MAX_TITLE_LENGTH = 60
const NOTE_GUIDANCE = 'Two or three short sentences at most.'

/** The schema of a note field, with what it is for. */
function noteProperty(what: string): Record<string, unknown> {
  return { type: 'string', description: `${what} ${NOTE_GUIDANCE}` }
}

/** Lists places in the code as a card the user opens them from. */
function locationsTool(): GroveTool {
  return {
    name: 'show_locations',
    summary: 'Point the user at places in the code.',
    promptGuidelines: ['Call show_locations whenever your answer names places in the code'],
    description:
      'Point the user at the code your answer is about — where something is defined, where it ' +
      'is used, what you changed. Call it whenever your answer names places in the code, ' +
      'without waiting to be asked: the user reads your answer beside the editor and expects ' +
      'to jump to what it mentions. The locations appear as a card in the conversation, each ' +
      'with your note; nothing opens until the user picks one, which opens that file with the ' +
      'lines marked and your note and line annotations written above them, so listing them ' +
      'never gets in the way. Always say in the note what the user is looking at — a bare ' +
      'range leaves them guessing. Put every location for one answer ' +
      'in a single call, most relevant first. This does not read the files, so keep using ' +
      'your own read tools for that.\n\n' +
      'Set `steps` when the answer is a path through the code rather than a set of places — ' +
      '"how does a request get from the router to the database", "what happens when the user ' +
      'saves". The locations then become a walkthrough the user steps through in order from ' +
      'the editor, one place at a time, so list them in the order the code runs and give each ' +
      'a `title`. For "where is X", leave `steps` out.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the locations are, in a few words.' },
        steps: {
          type: 'boolean',
          description:
            'The locations are steps of one flow, in order, for the user to walk through. ' +
            'Optional; leave out for places that are not a sequence.'
        },
        locations: {
          type: 'array',
          description: 'The places, most relevant first; with `steps`, in the order they run.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path, or relative to the workspace root.'
              },
              title: {
                type: 'string',
                description: 'A few words naming this step, for a walkthrough. Optional.'
              },
              startLine: { type: 'number', description: 'First line, 1-based. Optional.' },
              endLine: { type: 'number', description: 'Last line, inclusive. Optional.' },
              note: noteProperty('What is here and why it matters, shown above the lines.'),
              annotations: {
                type: 'array',
                description:
                  'Optional remarks on single lines, shown above each of them in the editor: ' +
                  'what a line does, what is wrong with it.',
                items: {
                  type: 'object',
                  properties: {
                    line: { type: 'number', description: 'The line, 1-based.' },
                    text: noteProperty('The remark.')
                  },
                  required: ['line', 'text'],
                  additionalProperties: false
                }
              }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      required: ['locations'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{title}', input: 'hidden', result: 'hidden' },
    alwaysLoad: true,

    async execute(input, context) {
      const listed = locationsOf(input.locations)
      if (listed.length === 0) return { content: 'No locations to show.', isError: true }
      const locations = await anchorLocations(context.workspaceRoot, listed)

      const steps = input.steps === true
      const view: UiNode = {
        kind: 'locations',
        locations,
        fallbackText: describeLocations(locations, steps)
      }
      const title = textOf(input.title)
      if (title) view.title = title
      if (steps) view.steps = true
      context.surface(`locations:${randomUUID()}`, 'transcript', view)
      if (steps) {
        return {
          content:
            `Laid out ${locations.length} step(s) for the user to walk through. They are not ` +
            'on screen until the user starts, so say in words how the flow goes.'
        }
      }
      return {
        content:
          `Listed ${locations.length} location(s) for the user to open. They are not on ` +
          'screen until the user picks one, so say in words what each is.'
      }
    }
  }
}

/** Tool inputs arrive unvalidated; entries without a usable path are dropped. */
function locationsOf(value: unknown): CodeLocation[] {
  if (!Array.isArray(value)) return []
  const locations: CodeLocation[] = []
  for (const entry of value.slice(0, MAX_LOCATIONS)) {
    const location = locationOf(entry)
    if (location) locations.push(location)
  }
  return locations
}

/** One location, with its range made sensible, or null when it names no file. */
function locationOf(value: unknown): CodeLocation | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>
  const path = textOf(fields.path)
  if (!path) return null

  const location: CodeLocation = { path }
  const startLine = lineOf(fields.startLine)
  if (startLine !== null) {
    location.startLine = startLine
    let endLine = lineOf(fields.endLine)
    if (endLine === null || endLine < startLine) endLine = startLine
    location.endLine = endLine
  }
  const title = titleOf(fields.title)
  if (title) location.title = title
  const note = noteOf(fields.note)
  if (note) location.note = note
  const annotations = annotationsOf(fields.annotations)
  if (annotations.length > 0) location.annotations = annotations
  return location
}

/** Line remarks a model wrote; entries without a line or text are dropped. */
function annotationsOf(value: unknown): LineAnnotation[] {
  if (!Array.isArray(value)) return []
  const annotations: LineAnnotation[] = []
  for (const entry of value.slice(0, MAX_ANNOTATIONS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const fields = entry as Record<string, unknown>
    const line = lineOf(fields.line)
    const text = noteOf(fields.text)
    if (line === null || !text) continue
    annotations.push({ line, text })
  }
  return annotations
}

/** A note a model wrote, cut to the length a note should have; null when empty. */
function noteOf(value: unknown): string | null {
  const text = textOf(value)
  if (!text) return null
  if (text.length <= MAX_NOTE_LENGTH) return text
  return `${text.slice(0, MAX_NOTE_LENGTH - 1).trimEnd()}…`
}

/** A step's title, cut to fit the editor's walkthrough bar; null when empty. */
function titleOf(value: unknown): string | null {
  const text = textOf(value)
  if (!text) return null
  if (text.length <= MAX_TITLE_LENGTH) return text
  return `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

/** Adds the note a model wrote to a target, when it wrote one. */
function withNote(target: ShowTarget, value: unknown): ShowTarget {
  const note = noteOf(value)
  if (!note) return target
  return { ...target, note }
}

/** The card as plain text, for a client that cannot draw it; steps are numbered. */
function describeLocations(locations: CodeLocation[], steps: boolean): string {
  const lines = locations.map((location, index) => {
    if (!steps) return describeLocation(location)
    return `${index + 1}. ${describeLocation(location)}`
  })
  return lines.join('\n')
}

/** One location as plain text. */
function describeLocation(location: CodeLocation): string {
  let place = location.path
  if (location.title) place = `${location.title}: ${place}`
  if (location.startLine !== undefined) place += `:${location.startLine}`
  if (location.endLine !== undefined && location.endLine !== location.startLine) {
    place += `-${location.endLine}`
  }
  if (!location.note) return place
  return `${place} — ${location.note}`
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
        path: { type: 'string', description: 'Optional file, absolute or workspace-relative.' },
        note: noteProperty('What to look for in the changes, shown as the diff opens.')
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{path}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const path = textOf(input.path)
      if (!path) return show(context, withNote({ kind: 'diff' }, input.note), 'the changed files')
      return show(context, withNote({ kind: 'diff', path }, input.note), `the diff of ${path}`)
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
        number: { type: 'number', description: 'The issue or pull request number.' },
        note: noteProperty('Why you are showing it, shown as it opens.')
      },
      required: ['number'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '#{number}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const number = lineOf(input.number)
      if (number === null) return { content: 'Name the issue or pull request.', isError: true }
      return show(context, withNote({ kind: 'github', number }, input.note), `#${number}`)
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
        pane: { type: 'string', description: 'The pane id. Leave out to list them.' },
        note: noteProperty('What to look at in the pane, shown as it opens.')
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
      const target = withNote({ kind: 'pane', pane: type.id }, input.note)
      return show(context, target, `the ${type.title} pane`)
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
