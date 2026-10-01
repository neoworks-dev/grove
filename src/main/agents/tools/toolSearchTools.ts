// Tools and skills loaded when the model needs them, not up front.
//
// A tool's schema in the request costs tokens on every turn, and adding one
// mid-conversation changes the start of the cached prompt. So grove mode lists
// most tools by name and summary only; `tool_search` returns a tool's full
// description, rules and schema, or a skill's instructions, as a tool result,
// and `call_tool` runs a loaded tool. The tools the harness is given never
// change, and the prompt cache holds on every harness.

import type { GroveSkill, GroveTool } from '../harness'
import { limitOf, stringOrNothing } from './toolInput'

export const TOOL_SEARCH = 'tool_search'
export const CALL_TOOL = 'call_tool'

const DEFAULT_RESULTS = 5
const MAX_RESULTS = 20

/** A tool or skill `tool_search` can return. */
type Entry = { kind: 'tool'; tool: GroveTool } | { kind: 'skill'; skill: GroveSkill }

/** Finds tools and skills and returns what they need to be used. Offered in every mode. */
export function toolSearchTool(skills: () => GroveSkill[]): GroveTool {
  return {
    name: TOOL_SEARCH,
    alwaysLoad: true,
    summary: 'Load a tool or skill: its full description and input schema, or the skill’s instructions',
    description: `Load tools and skills that are listed by name only. "select:name,other" loads exactly those; any other query searches names and descriptions by keyword. Returns each tool's description, rules and input schema, and each skill's instructions.`,
    promptGuidelines: [
      `Before using a tool or skill listed by name only, load it with ${TOOL_SEARCH}`
    ],
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '"select:name,other" for exact names, or keywords.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `Most results to return. Defaults to ${DEFAULT_RESULTS}.`
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { title: 'Load tools', label: '{query}', input: 'hidden', result: 'text' },

    execute(input, context) {
      const query = stringOrNothing(input.query)
      if (!query) return { content: 'Give a query.', isError: true }
      let tools: GroveTool[] = []
      if (context.tools) tools = context.tools()
      const entries = searchable(tools, skills())
      const found = search(entries, query, limitOf(input.limit, DEFAULT_RESULTS))
      if (found.length === 0) return { content: `Nothing matches "${query}".` }
      return { content: found.map(entryText).join('\n\n') }
    }
  }
}

/**
 * Runs a tool loaded with `tool_search`. Grove's tool server answers the call
 * as one to the tool it names, approval and all, so this never runs itself.
 */
export function callTool(): GroveTool {
  return {
    name: CALL_TOOL,
    alwaysLoad: true,
    summary: `Call a tool loaded with ${TOOL_SEARCH}`,
    description: `Call a tool that is listed by name only, after loading it with ${TOOL_SEARCH}. Pass the tool's name and its input as its schema describes.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool to call.' },
        input: { type: 'object', description: 'The tool’s input, as its schema describes.' }
      },
      required: ['name', 'input'],
      additionalProperties: false
    },
    policy: 'allow',
    execute() {
      return { content: `${CALL_TOOL} is answered by grove's tool server.`, isError: true }
    }
  }
}

/** The tool and input a `call_tool` call names, or null when its input does not name one. */
export function dispatchedCall(input: unknown): { name: string; input: Record<string, unknown> } | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const name = stringOrNothing(record.name)
  if (!name) return null
  let inner: Record<string, unknown> = {}
  if (record.input && typeof record.input === 'object') inner = record.input as Record<string, unknown>
  return { name, input: inner }
}

/** Everything `tool_search` can return: the session's tools but the two that load the rest, then skills. */
function searchable(tools: GroveTool[], skills: GroveSkill[]): Entry[] {
  const entries: Entry[] = []
  for (const tool of tools) {
    if (tool.name === TOOL_SEARCH || tool.name === CALL_TOOL) continue
    if (tool.policy === 'deny') continue
    entries.push({ kind: 'tool', tool })
  }
  for (const skill of skills) entries.push({ kind: 'skill', skill })
  return entries
}

/** The entries a query asks for, best first. */
function search(entries: Entry[], query: string, limit: number): Entry[] {
  const trimmed = query.trim()
  if (trimmed.startsWith('select:')) return selected(entries, trimmed.slice('select:'.length))
  const terms = trimmed.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  const scored = entries
    .map((entry) => ({ entry, score: scoreOf(entry, terms) }))
    .filter((candidate) => candidate.score > 0)
  scored.sort((first, second) => second.score - first.score)
  return scored.slice(0, Math.min(limit, MAX_RESULTS)).map((candidate) => candidate.entry)
}

/** The entries named in a comma-separated list, in the order named. */
function selected(entries: Entry[], list: string): Entry[] {
  const names = list.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
  const found: Entry[] = []
  for (const name of names) {
    const entry = entries.find((candidate) => nameOf(candidate) === name)
    if (entry) found.push(entry)
  }
  return found
}

/** How well an entry matches the terms: a hit in the name counts most. */
function scoreOf(entry: Entry, terms: string[]): number {
  const name = nameOf(entry).toLowerCase()
  const text = textOf(entry).toLowerCase()
  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += 3
    if (text.includes(term)) score += 1
  }
  return score
}

function nameOf(entry: Entry): string {
  if (entry.kind === 'tool') return entry.tool.name
  return entry.skill.name
}

/** What a keyword search reads besides the name. */
function textOf(entry: Entry): string {
  if (entry.kind === 'tool') return `${entry.tool.summary} ${entry.tool.description}`
  return entry.skill.description
}

/** An entry as the model reads it: what a tool needs to be called, or a skill's instructions. */
function entryText(entry: Entry): string {
  if (entry.kind === 'skill') {
    const { skill } = entry
    return `<skill name="${skill.name}">\n${skill.description}\n\n${skill.instructions.trim()}\n</skill>`
  }
  const { tool } = entry
  const lines = [`<tool name="${tool.name}">`, tool.description]
  if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
    lines.push('Rules:', ...tool.promptGuidelines.map((rule) => `- ${rule}`))
  }
  lines.push(`Input schema: ${JSON.stringify(tool.inputSchema)}`, '</tool>')
  return lines.join('\n')
}
