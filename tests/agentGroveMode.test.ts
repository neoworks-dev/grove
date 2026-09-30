// Grove mode is a switch on a session, not a harness: the harness the session
// names still runs it, on grove's prompt and workspace tools instead of its own.

import { describe, expect, test } from 'bun:test'
import type { SessionInit } from '@neoworks/harness'
import type { GroveTool, HarnessRunOptions } from '../src/main/agents/harness'
import { parseSession } from '../src/main/agents/store'
import { switchboardHarness } from '../src/main/agents/switchboard/descriptor'
import { CAPABILITIES, nativeOptions } from '../src/main/agents/switchboard/harnesses'
import type { SwitchboardHost } from '../src/main/agents/switchboard/host'
import type { ToolBinding } from '../src/main/agents/switchboard/mcpServer'

/** A tool standing in for the workspace tools grove mode serves. */
const WORKSPACE_TOOL = {
  name: 'read',
  summary: 'Read a file',
  description: 'Read a file, in full.',
  promptGuidelines: ['Read only what you need'],
  inputSchema: { type: 'object' },
  run: () => Promise.resolve({ content: '' })
} as unknown as GroveTool

/** Start a run on a harness that has grove mode, and report what switchboard was handed. */
async function startOn(groveMode: boolean): Promise<{ init: SessionInit; tools: GroveTool[] }> {
  let init: SessionInit | null = null
  let binding: ToolBinding | null = null
  const host = {
    switchboard: () =>
      Promise.resolve({
        listHarnesses: () => Promise.resolve([{ id: 'codex', available: true, capabilities: {} }]),
        createSession: (given: SessionInit) => {
          init = given
          return Promise.resolve({ id: 'harness-1', onEvent: () => () => {} })
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
    id: 'codex',
    label: 'Codex',
    description: '',
    icon: '',
    capabilities: CAPABILITIES,
    runsOn: ['codex'],
    profile: () => ({ sessionOptions: nativeOptions }),
    groveModeTools: () => [WORKSPACE_TOOL]
  })
  await descriptor.start(runOptions(groveMode))
  if (!init || !binding) throw new Error('the run did not start')
  return { init, tools: (binding as ToolBinding).tools() }
}

function runOptions(groveMode: boolean): HarnessRunOptions {
  return {
    sessionId: 's1',
    workspaceRoot: '/w',
    provider: 'codex',
    model: 'gpt-5',
    thinkingLevel: 'off',
    activeTools: null,
    permissionMode: 'default',
    groveMode,
    resumeKey: null,
    tools: [],
    systemPrompt: 'You are Oak.',
    emit: () => {},
    emitFrom: () => {},
    stats: () => {},
    startingStats: {
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0
    },
    confirm: () => Promise.resolve({ result: 'allow' }),
    storeImage: () => ({ type: 'image', ref: 'blob-1', mediaType: 'image/png' }) as never,
    shellOutput: { begin: () => {}, append: () => {}, end: () => {} }
  } as HarnessRunOptions
}

describe('grove mode on a harness', () => {
  test('replaces the prompt and tools, and keeps the harness', async () => {
    const { init, tools } = await startOn(true)
    expect(init.harness).toBe('codex')
    expect(init.options?.tools).toBe('none')
    expect(init.options?.systemPrompt).toHaveProperty('replace')
    const prompt = (init.options?.systemPrompt as { replace: string }).replace
    expect(prompt).toContain('<tools>\n- read: Read a file\n</tools>')
    expect(prompt).toContain('- Read only what you need')
    expect(prompt).toContain('You are Oak.')
    expect(init.options?.model).toBe('gpt-5')
    expect(tools.map((tool) => tool.name)).toEqual(['read'])
  })

  test('off, the harness runs as it comes', async () => {
    const { init, tools } = await startOn(false)
    expect(init.harness).toBe('codex')
    expect(init.options?.tools).toBeUndefined()
    const prompt = (init.options?.systemPrompt as { append: string }).append
    expect(prompt).toStartWith('You are running inside Grove')
    expect(prompt).not.toContain('<tools>')
    expect(prompt).toContain('You are Oak.')
    expect(tools).toEqual([])
  })
})

describe('sessions stored on the grove harness', () => {
  /** A stored session as it was written, with the fields that matter here. */
  function stored(fields: Record<string, unknown>): string {
    return JSON.stringify({ id: 's1', title: 'Session', labels: {}, ...fields })
  }

  test('move onto Claude Code, on its Anthropic route', () => {
    const session = parseSession(stored({ harness: 'grove', provider: 'claude', model: 'claude-opus-5-5' }))
    expect(session.harness).toBe('claude')
    expect(session.provider).toBe('anthropic')
    expect(session.groveMode).toBe(true)
  })

  test('move onto pi, under the provider its model names', () => {
    const session = parseSession(stored({ harness: 'grove', provider: 'pi', model: 'openai/gpt-5' }))
    expect(session.harness).toBe('pi')
    expect(session.provider).toBe('openai')
    expect(session.groveMode).toBe(true)
  })

  test('any other session reads back without grove mode', () => {
    const session = parseSession(stored({ harness: 'codex', provider: 'codex', model: 'gpt-5' }))
    expect(session.harness).toBe('codex')
    expect(session.groveMode).toBe(false)
  })
})
