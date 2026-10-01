// Grove mode gives the harness only the tools marked alwaysLoad; the rest are
// listed by name, loaded with tool_search and called through call_tool, so the
// tools the harness holds never change mid-conversation.

import { describe, expect, test } from 'bun:test'
import type { HarnessEvent, SessionInit } from '@neoworks/harness'
import type { ServerEventBody } from '../src/shared/agents'
import type { GroveSkill, GroveTool, GroveToolContext, HarnessRunOptions } from '../src/main/agents/harness'
import { groveModePrompt } from '../src/main/agents/systemPrompt'
import { switchboardHarness } from '../src/main/agents/switchboard/descriptor'
import { CAPABILITIES, nativeOptions } from '../src/main/agents/switchboard/harnesses'
import type { SwitchboardHost } from '../src/main/agents/switchboard/host'
import type { ToolBinding } from '../src/main/agents/switchboard/mcpServer'
import { callTool, toolSearchTool } from '../src/main/agents/tools/toolSearchTools'

function tool(name: string, fields: Partial<GroveTool> = {}): GroveTool {
  return {
    name,
    summary: `The ${name} tool`,
    description: `Does what ${name} does.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    policy: 'allow',
    execute: () => ({ content: '' }),
    ...fields
  }
}

const SKILL: GroveSkill = {
  name: 'release-notes',
  description: 'Write release notes from merged pull requests',
  instructions: 'Group the changes by area.'
}

/** What tool_search answers, searching these tools and the one skill. */
async function searchFor(query: string, tools: GroveTool[]): Promise<string> {
  const search = toolSearchTool(() => [SKILL])
  const context = { sessionId: 's1', workspaceRoot: '/w', tools: () => tools } as unknown as GroveToolContext
  const result = await search.execute({ query }, context)
  return result.content
}

describe('tool_search', () => {
  const tools = [
    tool('show_diff', { promptGuidelines: ['Show diffs before asking for review'] }),
    tool('spawn_agent', { description: 'Start another agent in a worktree.' }),
    tool('hidden', { policy: 'deny' })
  ]

  test('select: loads exactly the named tools and skills, with their rules and schema', async () => {
    const text = await searchFor('select:show_diff,release-notes', tools)
    expect(text).toContain('<tool name="show_diff">')
    expect(text).toContain('- Show diffs before asking for review')
    expect(text).toContain('Input schema: {"type":"object"')
    expect(text).toContain('<skill name="release-notes">')
    expect(text).toContain('Group the changes by area.')
    expect(text).not.toContain('spawn_agent')
  })

  test('keywords find a tool by what it does', async () => {
    const text = await searchFor('agent worktree', tools)
    expect(text).toStartWith('<tool name="spawn_agent">')
  })

  test('a denied tool is never returned', async () => {
    expect(await searchFor('select:hidden', tools)).toContain('Nothing matches')
  })
})

describe('the grove mode prompt', () => {
  const prompt = groveModePrompt(
    [
      tool('read', { alwaysLoad: true, promptGuidelines: ['Read only what you need'] }),
      tool('show_diff', { promptGuidelines: ['Show diffs before asking for review'] })
    ],
    '',
    { workspaceRoot: '/w', platform: 'linux', today: '2026-10-01' }
  )

  test('gives the tools loaded up front with their rules', () => {
    expect(prompt).toContain('<tools>\n- read: The read tool\n</tools>')
    expect(prompt).toContain('- Read only what you need')
  })

  test('lists the rest by name and summary only', () => {
    expect(prompt).toContain('<more_tools>')
    expect(prompt).toContain('- show_diff: The show_diff tool')
    expect(prompt).not.toContain('Show diffs before asking for review')
  })
})

describe('grove mode on a harness', () => {
  /** Start a grove mode run over these workspace tools, with what the harness reports fed in by hand. */
  async function startRun(workspace: GroveTool[]): Promise<{
    binding: ToolBinding
    report: (event: HarnessEvent) => void
    emitted: ServerEventBody[]
  }> {
    let binding: ToolBinding | null = null
    let listener: ((event: HarnessEvent) => void) | null = null
    let init: SessionInit | null = null
    const emitted: ServerEventBody[] = []
    const host = {
      switchboard: () =>
        Promise.resolve({
          listHarnesses: () => Promise.resolve([{ id: 'claude', available: true, capabilities: {} }]),
          createSession: (given: SessionInit) => {
            init = given
            return Promise.resolve({
              id: 'harness-1',
              onEvent: (handle: (event: HarnessEvent) => void) => {
                listener = handle
                return () => {}
              }
            })
          }
        }),
      toolServer: {
        bind: (bound: ToolBinding) => {
          binding = bound
          return Promise.resolve({
            server: { type: 'http', name: 'grove', url: 'http://127.0.0.1:1/mcp', headers: [] },
            dispose: () => {}
          })
        }
      }
    } as unknown as SwitchboardHost
    const descriptor = switchboardHarness(host, {
      id: 'claude',
      label: 'Claude Code',
      description: '',
      icon: '',
      capabilities: CAPABILITIES,
      runsOn: ['claude'],
      profile: () => ({ sessionOptions: nativeOptions }),
      groveModeTools: () => workspace
    })
    await descriptor.start({
      sessionId: 's1',
      workspaceRoot: '/w',
      provider: 'anthropic',
      model: null,
      thinkingLevel: 'off',
      activeTools: null,
      permissionMode: 'default',
      groveMode: true,
      resumeKey: null,
      tools: [tool('show_diff')],
      systemPrompt: '',
      emit: (body: ServerEventBody) => emitted.push(body),
      emitFrom: () => {},
      stats: () => {},
      startingStats: {
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0
      },
      confirm: () => Promise.resolve({ result: 'allow' }),
      storeImage: () => ({ type: 'image', ref: 'blob-1', mediaType: 'image/png' }) as never,
      shellOutput: { begin: () => {}, append: () => {}, end: () => {} }
    } as HarnessRunOptions)
    if (!binding || !listener || !init) throw new Error('the run did not start')
    return { binding, report: listener, emitted }
  }

  test('the harness is given only the tools loaded up front, and can call every one', async () => {
    const { binding } = await startRun([tool('read', { alwaysLoad: true }), callTool()])
    expect(binding.listed().map((entry) => entry.name)).toEqual(['read', 'call_tool'])
    expect(binding.tools().map((entry) => entry.name)).toEqual(['show_diff', 'read', 'call_tool'])
  })

  test('a call through call_tool is logged as a call to the tool it named', async () => {
    const { report, emitted } = await startRun([tool('read', { alwaysLoad: true }), callTool()])
    report({
      type: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'mcp__grove__call_tool',
        name: 'mcp__grove__call_tool',
        rawInput: { name: 'show_diff', input: { text: 'a' } }
      }
    } as unknown as HarnessEvent)
    report({
      type: 'update',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }
    } as unknown as HarnessEvent)

    const updates = emitted.filter((body) => body.type === 'update').map((body) => body.update)
    expect(updates[0]).toMatchObject({
      name: 'mcp__grove__show_diff',
      title: 'show_diff',
      rawInput: { text: 'a' }
    })
    expect(updates[1]).toMatchObject({ name: 'mcp__grove__show_diff', status: 'completed' })
  })
})
