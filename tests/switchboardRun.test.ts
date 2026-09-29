// One session's run on switchboard, against a fake switchboard.
//
// The run is where ACP meets grove: updates go on the log as they came, a
// subagent's updates go to a session of its own, permission requests are
// answered from grove's approval flow, and the turn's end settles the session.

import { describe, expect, test } from 'bun:test'
import type {
  HarnessEvent,
  PermissionReply,
  PromptResult,
  QuestionReply,
  QuestionRequest,
  RequestPermissionRequest,
  SessionInit,
  SessionUpdate
} from '@neoworks/harness'
import type {
  ApprovalDecision,
  GroveTool,
  HarnessRunOptions,
  SessionStats,
  SubagentIdentity
} from '../src/main/agents/harness'
import type { ToolBinding } from '../src/main/agents/switchboard/mcpServer'
import type { SwitchboardHost } from '../src/main/agents/switchboard/host'
import { SwitchboardRun, type RunProfile } from '../src/main/agents/switchboard/run'
import type { ServerEventBody } from '../src/shared/agents'

/** A turn the test ends when it likes. */
function turn(): { run: PromiseLike<PromptResult>; finish(result: PromptResult): void; fail(cause: Error): void } {
  let finish: (result: PromptResult) => void = () => {}
  let fail: (cause: Error) => void = () => {}
  const run = new Promise<PromptResult>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  return { run, finish, fail }
}

/** A harness session the test drives: it reports what the test says, and records what it is told. */
class FakeSession {
  readonly id = 'harness-1'
  readonly harness = 'claude' as const
  listener: (event: HarnessEvent) => void = () => {}
  turns: ReturnType<typeof turn>[] = []
  steered: unknown[] = []

  constructor(readonly init: SessionInit) {}

  prompt(): PromiseLike<PromptResult> {
    const next = turn()
    this.turns.push(next)
    return next.run
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listener = listener
    return () => {}
  }

  steer(content: unknown): Promise<void> {
    this.steered.push(content)
    return Promise.resolve()
  }

  setPermissions(): Promise<void> {
    return Promise.resolve()
  }

  cancel(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  report(update: SessionUpdate): void {
    this.listener({ type: 'update', update } as HarnessEvent)
  }

  ask(request: RequestPermissionRequest): Promise<PermissionReply> {
    if (!this.init.onPermission) throw new Error('no permission handler')
    return Promise.resolve(this.init.onPermission(request))
  }

  question(request: QuestionRequest): Promise<QuestionReply> {
    if (!this.init.onQuestion) throw new Error('no question handler')
    return Promise.resolve(this.init.onQuestion(request))
  }

  send(event: HarnessEvent): void {
    this.listener(event)
  }
}

interface Fixture {
  run: SwitchboardRun
  session: FakeSession
  binding: ToolBinding
  emitted: ServerEventBody[]
  fromSubagents: { agent: SubagentIdentity; body: ServerEventBody }[]
  stats: SessionStats[]
  confirmed: RequestPermissionRequest[]
  shell: string[]
}

async function started(
  options: {
    decide?: (request: RequestPermissionRequest) => ApprovalDecision
    profileTools?: GroveTool[]
    editedInput?: boolean
  } = {}
): Promise<Fixture> {
  let session: FakeSession | null = null
  let binding: ToolBinding | null = null
  const host = {
    switchboard: () =>
      Promise.resolve({
        listHarnesses: () =>
          Promise.resolve([{ id: 'claude', available: true, capabilities: { editedInput: options.editedInput === true } }]),
        createSession: (init: SessionInit) => {
          session = new FakeSession(init)
          return Promise.resolve(session)
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

  const emitted: ServerEventBody[] = []
  const fromSubagents: { agent: SubagentIdentity; body: ServerEventBody }[] = []
  const stats: SessionStats[] = []
  const confirmed: RequestPermissionRequest[] = []
  const shell: string[] = []
  let decide = options.decide
  if (!decide) decide = () => ({ result: 'allow' })
  const decideWith = decide

  const runOptions: HarnessRunOptions = {
    sessionId: 's1',
    workspaceRoot: '/w',
    provider: null,
    model: null,
    thinkingLevel: 'off',
    activeTools: null,
    permissionMode: 'default',
    resumeKey: null,
    tools: [],
    systemPrompt: '',
    emit: (body) => emitted.push(body),
    emitFrom: (agent, body) => fromSubagents.push({ agent, body }),
    stats: (update) => stats.push(update),
    startingStats: {
      usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 1
    },
    confirm: (request) => {
      confirmed.push(request)
      return Promise.resolve(decideWith(request))
    },
    storeImage: () => ({ type: 'image', ref: 'blob-1', mediaType: 'image/png' }) as never,
    shellOutput: {
      begin: (toolUseId) => shell.push(`begin ${toolUseId}`),
      append: (toolUseId, text) => shell.push(`append ${toolUseId} ${text}`),
      end: (toolUseId) => shell.push(`end ${toolUseId}`)
    }
  }
  const profile: RunProfile = { harness: 'claude', sessionOptions: () => ({}) }
  if (options.profileTools) {
    const tools = options.profileTools
    profile.tools = () => tools
  }

  const run = new SwitchboardRun(host, profile, runOptions)
  await run.start()
  if (!session || !binding) throw new Error('the run did not open a session')
  return { run, session, binding, emitted, fromSubagents, stats, confirmed, shell }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const chunk: SessionUpdate = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'hello' }
}

describe('a switchboard run', () => {
  test('logs what the harness reports as it came, between running and idle', async () => {
    const { run, session, emitted } = await started()
    await run.prompt('go')
    session.report(chunk)
    session.turns[0].finish({ stopReason: 'end_turn' })
    await settle()

    expect(emitted).toEqual([
      { type: 'session.status_running' },
      { type: 'update', update: chunk },
      { type: 'session.status_idle', stopReason: 'end_turn' }
    ])
  })

  test('seeds switchboard with the totals the session already had', async () => {
    const { session } = await started()
    expect(session.init.usage).toEqual({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1 })
  })

  test("reports switchboard's running totals and context fill, off the log", async () => {
    const { session, emitted, stats } = await started()
    session.report({ sessionUpdate: 'usage_update', used: 1200, size: 200000 } as SessionUpdate)
    session.send({
      type: 'usage',
      total: { input: 15, output: 7, costUsd: 1.5 },
      context: { used: 1200, size: 200000 }
    })

    expect(emitted).toEqual([])
    expect(stats.at(-1)).toEqual({
      usage: { inputTokens: 15, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 1.5,
      contextUsed: 1200,
      contextWindow: 200000
    })
  })

  test("streams a command's output live and logs it once, when the command ends", async () => {
    const { session, emitted, shell } = await started()
    session.report({
      sessionUpdate: 'tool_call',
      toolCallId: 'sh1',
      name: 'shell',
      kind: 'execute',
      content: [{ type: 'terminal', terminalId: 'sh1' }],
      _meta: { terminal_info: { terminal_id: 'sh1' } }
    } as SessionUpdate)
    session.report({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'sh1',
      _meta: { terminal_output_delta: { terminal_id: 'sh1', data: 'one\n' } }
    } as SessionUpdate)
    session.report({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'sh1',
      status: 'completed',
      _meta: {
        terminal_output_delta: { terminal_id: 'sh1', data: 'two\n' },
        terminal_exit: { terminal_id: 'sh1', exit_code: 0, signal: null }
      }
    } as SessionUpdate)

    expect(shell).toEqual(['begin sh1', 'append sh1 one\n', 'append sh1 two\n', 'end sh1'])
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({
      update: {
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'one\ntwo\n' } }]
      }
    })
  })

  test("puts the agent's questions to the user and hands back the answers", async () => {
    const { session, confirmed } = await started({
      decide: () => ({ result: 'allow', input: { answers: { 'Which one?': 'B' } } })
    })
    const questions = [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }]
    const reply = await session.question({ toolCallId: 'q1', questions })

    expect(reply).toEqual({ answers: { 'Which one?': 'B' } })
    expect(confirmed[0].toolCall).toMatchObject({ toolCallId: 'q1', rawInput: { questions } })
  })

  test('a skipped question cancels the call', async () => {
    const { session } = await started({ decide: () => ({ result: 'deny' }) })
    const reply = await session.question({ toolCallId: 'q1', questions: [] })
    expect(reply).toBe('cancel')
  })

  test('a failed turn is an error, and the session goes idle', async () => {
    const { run, session, emitted } = await started()
    await run.prompt('go')
    session.turns[0].fail(new Error('the harness went away'))
    await settle()

    expect(emitted.slice(1)).toEqual([
      { type: 'session.error', message: 'the harness went away' },
      { type: 'session.status_idle', stopReason: 'error' }
    ])
  })

  test("sends a subagent's updates to a session of its own, named from the call that started it", async () => {
    const { session, emitted, fromSubagents } = await started()
    session.report({
      sessionUpdate: 'tool_call',
      toolCallId: 'task-1',
      title: 'Task',
      rawInput: { subagent_type: 'explore', prompt: 'map the review flow' }
    } as SessionUpdate)
    const inner = { ...chunk, _meta: { claudeCode: { parentToolUseId: 'task-1' } } } as SessionUpdate
    session.report(inner)

    expect(emitted).toHaveLength(1)
    expect(fromSubagents).toEqual([
      {
        agent: { toolUseId: 'task-1', title: 'explore', description: 'map the review flow' },
        body: { type: 'update', update: inner }
      }
    ])
  })

  test("lets a harness through on grove's own tools, which hold their calls themselves", async () => {
    const { session, confirmed } = await started()
    const reply = await session.ask({
      sessionId: 'harness-1',
      toolCall: { toolCallId: 'c1', name: 'mcp__grove__edit' },
      options: []
    })

    expect(reply).toBe('once')
    expect(confirmed).toHaveLength(0)
  })

  test("puts the harness's own tools to grove's approval flow", async () => {
    const { session, confirmed } = await started({ decide: () => ({ result: 'always_session' }) })
    const reply = await session.ask({
      sessionId: 'harness-1',
      toolCall: { toolCallId: 'c1', name: 'Bash', kind: 'execute' },
      options: []
    })

    expect(reply).toBe('always')
    expect(confirmed).toHaveLength(1)
  })

  test('a deny with a reason refuses the call and hands the agent the reason', async () => {
    const { session } = await started({ decide: () => ({ result: 'deny', reason: 'use rg' }) })
    const reply = await session.ask({ sessionId: 'harness-1', toolCall: { toolCallId: 'c1', name: 'Bash' }, options: [] })
    await settle()

    expect(reply).toBe('reject')
    expect(session.steered).toEqual(['use rg'])
  })

  test('an edited call runs with what the user changed, where the harness can', async () => {
    const { session } = await started({
      editedInput: true,
      decide: () => ({ result: 'allow', input: { command: 'ls -la' } })
    })
    const reply = await session.ask({ sessionId: 'harness-1', toolCall: { toolCallId: 'c1', name: 'Bash' }, options: [] })

    expect(reply).toEqual({ outcome: 'once', updatedInput: { command: 'ls -la' } })
  })

  test('where it cannot, the call is refused and the agent told what to run instead', async () => {
    const { session } = await started({ decide: () => ({ result: 'allow', input: { command: 'ls -la' } }) })
    const reply = await session.ask({ sessionId: 'harness-1', toolCall: { toolCallId: 'c1', name: 'Bash' }, options: [] })
    await settle()

    expect(reply).toBe('reject')
    expect(String(session.steered[0])).toContain('{"command":"ls -la"}')
  })

  test("keeps the diff a grove tool reported when the harness's result arrives", async () => {
    const { session, binding, emitted } = await started()
    const diff = { type: 'diff' as const, path: '/w/a.ts', oldText: 'a', newText: 'b' }
    binding.report('c1', { content: [diff] })
    const text = { type: 'content' as const, content: { type: 'text' as const, text: 'Edited a.ts.' } }
    session.report({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [text] })

    expect(emitted[0]).toEqual({
      type: 'update',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [diff] }
    })
    expect(emitted[1]).toMatchObject({ update: { status: 'completed', content: [diff, text] } })
  })

  test("plan mode refuses the profile's tools that change things, and no others", async () => {
    const edit: GroveTool = {
      name: 'edit',
      summary: 'edit',
      description: '',
      inputSchema: {},
      policy: 'ask',
      execute: () => ({ content: '' })
    }
    const read: GroveTool = { ...edit, name: 'read', policy: 'allow' }
    const { run, binding } = await started({ profileTools: [edit, read] })

    expect(binding.refusal(edit)).toBeNull()
    await run.setPermissionMode('plan')
    expect(binding.refusal(edit)).toContain('plan mode')
    expect(binding.refusal(read)).toBeNull()
  })
})
