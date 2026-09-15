// grove's own tools, offered to every harness that can host them.
//
// These used to be extensions loaded into the agent server, which meant they
// could not call back into grove and had to reach it through files. Now they run
// in grove's own process, so `send_message` posts on the worktree channel
// directly and `set_phase` publishes a surface on the session's event log.
//
// Each harness adapter translates these into whatever its SDK calls a tool:
// an in-process MCP server for Claude, `defineTool` for pi. A harness that
// cannot host tools is given none and loses only the features they add.

import type { OpenFileTarget } from '../../shared/agents'
import type { WorktreeChannel } from '../worktreeChannel'
import type { GroveTool } from './harness'

// The surface id the intro pane watches. Changing it means changing
// src/renderer/src/lib/intro.svelte.ts.
const INTRO_SURFACE_ID = 'grove.intro'

// Kept in step with INTRO_PHASES in src/renderer/src/lib/intro/prompt.ts.
const INTRO_PHASES = ['explore', 'interview', 'example', 'feedback', 'config', 'done']

// Agent-to-agent chatter can loop; a ceiling per minute keeps a runaway cheap.
const MAX_SENDS_PER_MINUTE = 30
const MINUTE_MS = 60_000

export interface GroveToolOptions {
  chat: WorktreeChannel
  now?: () => number
}

/**
 * The review protocol.
 *
 * `policy: 'ask'` is the whole mechanism: the harness parks its loop on the
 * confirmation, grove raises the diff, and answering the approval is what
 * releases the agent. `execute` therefore decides nothing — by the time it runs
 * the call has already been allowed, and the verdict arrives as a message.
 */
function requestReviewTool(): GroveTool {
  return {
    name: 'request_review',
    summary: 'Ask the user to review the changes you have made so far.',
    description:
      'Submit the file changes you have made so far for review. The user reads them as a diff ' +
      'and may revert individual hunks or comment on them; you are told the outcome before you ' +
      'continue. Call this when you have finished a coherent piece of work, not after every ' +
      'edit, and summarize what you changed and why.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One or two sentences on what you changed and why, for the review header.'
        }
      },
      required: ['summary'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{summary}', input: 'hidden', result: 'text' },

    execute() {
      return { content: 'Submitted for review.' }
    }
  }
}

/**
 * The onboarding stepper.
 *
 * The intro pane follows a fixed set of phases. Reporting one publishes a
 * surface on the session's own event log, which is the stream the pane is
 * already watching.
 */
function setPhaseTool(): GroveTool {
  return {
    name: 'set_phase',
    summary: 'Report which onboarding phase you are entering.',
    description:
      'Report the onboarding phase you are entering, so the introduction page can show ' +
      'progress. Call this as you begin each phase, not after finishing it.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          enum: INTRO_PHASES,
          description: 'The onboarding phase you are entering.'
        }
      },
      required: ['phase'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{phase}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const phase = String(input.phase)
      context.surface(INTRO_SURFACE_ID, 'panel', {
        kind: 'text',
        text: phase,
        fallbackText: phase
      })
      return { content: `Phase set to ${phase}.` }
    }
  }
}

/**
 * The editor handoff.
 *
 * An answer that names files is worth more with those files on screen, so the
 * agent can put them there itself instead of leaving the user to open each one.
 * The renderer opens them in the order given, so the first entry is the one it
 * leaves focused.
 */
function openFilesTool(): GroveTool {
  return {
    name: 'open_files',
    summary: 'Open files in the user’s editor.',
    description:
      'Open files in the editor the user is looking at, optionally at a line. Call this ' +
      'whenever your answer points at code — where something is defined, where it is used, ' +
      'what you changed — so the user lands on it instead of having to search for it. Put the ' +
      'most relevant file first; that is the one left in view. This does not read the files, ' +
      'so keep using your own read tools for that.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'The files to open, most relevant first.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path, or relative to the workspace root.'
              },
              line: { type: 'number', description: 'Optional 1-based line to reveal.' }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      required: ['files'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{files}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const targets = openFileTargets(input.files)
      if (targets.length === 0) return { content: 'No files to open.', isError: true }
      context.openFiles(targets)
      return { content: `Opened ${targets.map((target) => target.path).join(', ')}.` }
    }
  }
}

/** Tool inputs arrive unvalidated; entries without a usable path are dropped. */
function openFileTargets(value: unknown): OpenFileTarget[] {
  if (!Array.isArray(value)) return []
  const targets: OpenFileTarget[] = []
  for (const entry of value) {
    const path = pathOf(entry)
    if (path === null) continue
    const line = lineOf(entry)
    if (line === null) targets.push({ path })
    else targets.push({ path, line })
  }
  return targets
}

function pathOf(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.length > 0) return entry
  if (typeof entry !== 'object' || entry === null) return null
  const path = (entry as Record<string, unknown>).path
  if (typeof path !== 'string' || path.length === 0) return null
  return path
}

function lineOf(entry: unknown): number | null {
  if (typeof entry !== 'object' || entry === null) return null
  const line = (entry as Record<string, unknown>).line
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return null
  return Math.floor(line)
}

/** The shared worktree channel: one place the user and every agent can talk. */
function chatTools(options: GroveToolOptions): GroveTool[] {
  const now = options.now ?? ((): number => Date.now())
  const sendTimes: number[] = []

  function withinRateLimit(): boolean {
    const timestamp = now()
    while (sendTimes.length > 0 && timestamp - sendTimes[0] > MINUTE_MS) sendTimes.shift()
    if (sendTimes.length >= MAX_SENDS_PER_MINUTE) return false
    sendTimes.push(timestamp)
    return true
  }

  const send: GroveTool = {
    name: 'send_message',
    summary: 'Send a message to the other agents and the user in this worktree.',
    description:
      "Post a message on this worktree's shared channel, which the user and any other agents " +
      'working here can read. Use it to coordinate, not to report routine progress. Address one ' +
      'agent with "to".',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        to: { type: 'string', description: 'Optional agent or session to address.' }
      },
      required: ['text'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{text}', input: 'hidden', result: 'hidden' },

    async execute(input, context) {
      if (!withinRateLimit()) {
        return { content: 'Rate limited: too many messages in the last minute.', isError: true }
      }
      await options.chat.post(
        context.workspaceRoot,
        { kind: 'agent', name: context.sessionId },
        String(input.text),
        stringOrNothing(input.to)
      )
      return { content: 'Message sent.' }
    }
  }

  const read: GroveTool = {
    name: 'read_messages',
    summary: "Read recent messages from this worktree's shared channel.",
    description:
      "Read what the user and any other agents have posted on this worktree's shared channel. " +
      'Pass "since" to read only what is new to you.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only messages after this epoch-ms timestamp.' }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: 'channel', input: 'hidden', result: 'text' },

    async execute(input, context) {
      const since = typeof input.since === 'number' ? input.since : undefined
      const messages = await options.chat.list(context.workspaceRoot, since)
      if (messages.length === 0) return { content: 'No messages.' }
      return { content: messages.map((entry) => `[${entry.from.name}] ${entry.text}`).join('\n') }
    }
  }

  return [send, read]
}

/** Tool inputs arrive unvalidated; an addressee that is not a string has none. */
function stringOrNothing(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value
}

/** Every tool grove contributes, in the order they are offered to a harness. */
export function groveTools(options: GroveToolOptions): GroveTool[] {
  return [requestReviewTool(), setPhaseTool(), openFilesTool(), ...chatTools(options)]
}
