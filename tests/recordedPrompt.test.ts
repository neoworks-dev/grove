// A harness resumes a conversation from its own transcript but takes the system
// prompt from the options it is started with. A prompt composed again on resume
// differs (the date, the peers, the title) and costs the whole prompt cache, so
// a run records the prompt it starts a conversation with and is handed it back.

import { describe, expect, test } from 'bun:test'
import type { SessionInit } from '@neoworks/harness'
import type { RecordedPrompt, ServerEventBody } from '../src/shared/agents'
import type { HarnessRunOptions } from '../src/main/agents/harness'
import { switchboardHarness } from '../src/main/agents/switchboard/descriptor'
import { CAPABILITIES, nativeOptions } from '../src/main/agents/switchboard/harnesses'
import type { SwitchboardHost } from '../src/main/agents/switchboard/host'

interface Started {
  init: SessionInit
  emitted: ServerEventBody[]
}

/** Start a run with the given context, and report what switchboard was handed and what was logged. */
async function start(
  context: string,
  resumeKey: string | null,
  recordedPrompt?: RecordedPrompt
): Promise<Started> {
  let init: SessionInit | null = null
  const emitted: ServerEventBody[] = []
  const open = (given: SessionInit) => {
    init = given
    return Promise.resolve({ id: 'harness-1', onEvent: () => () => {} })
  }
  const host = {
    switchboard: () =>
      Promise.resolve({
        listHarnesses: () => Promise.resolve([{ id: 'claude', available: true, capabilities: {} }]),
        createSession: open,
        resumeSession: (_key: string, given: SessionInit) => open(given)
      }),
    toolServer: {
      bind: () =>
        Promise.resolve({
          server: { type: 'http', name: 'grove', url: 'http://127.0.0.1:1/mcp', headers: [] },
          dispose: () => {}
        })
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
    groveModeTools: () => []
  })
  await descriptor.start(runOptions(context, resumeKey, recordedPrompt, emitted))
  if (!init) throw new Error('the run did not start')
  return { init, emitted }
}

function runOptions(
  context: string,
  resumeKey: string | null,
  recordedPrompt: RecordedPrompt | undefined,
  emitted: ServerEventBody[]
): HarnessRunOptions {
  return {
    sessionId: 's1',
    workspaceRoot: '/w',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    thinkingLevel: 'off',
    activeTools: null,
    permissionMode: 'default',
    groveMode: true,
    resumeKey,
    recordedPrompt,
    tools: [],
    systemPrompt: context,
    emit: (body) => emitted.push(body),
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

/** The prompt a run recorded on the log, or null when it recorded none. */
function recordedBy(started: Started): RecordedPrompt | null {
  for (const body of started.emitted) {
    if (body.type === 'session.system_prompt') return body.systemPrompt
  }
  return null
}

describe('the system prompt across a resume', () => {
  test('a fresh conversation records the prompt it was handed', async () => {
    const started = await start('You are "Oak".', null)
    expect(recordedBy(started)).toEqual(started.init.options?.systemPrompt as RecordedPrompt)
    expect(started.init.options?.systemPrompt?.replace).toContain('You are "Oak".')
  })

  test('a resumed conversation is handed the recorded prompt, not one composed now', async () => {
    const first = await start('You are "Oak".', null)
    const recorded = recordedBy(first)
    if (!recorded) throw new Error('nothing was recorded')

    const resumed = await start('You are "Renamed", and a peer joined.', 'conversation-1', recorded)
    expect(resumed.init.options?.systemPrompt).toEqual(recorded)
    expect(recordedBy(resumed)).toBeNull()
  })

  test('a resume with nothing recorded records what it composes', async () => {
    const resumed = await start('You are "Oak".', 'conversation-1')
    expect(recordedBy(resumed)).toEqual(resumed.init.options?.systemPrompt as RecordedPrompt)
  })
})
