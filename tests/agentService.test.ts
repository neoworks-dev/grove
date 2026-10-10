// The service is the contract every harness is written against: it starts a run
// on first prompt, folds what the run emits onto the log, holds tool calls until
// grove answers them, and queues anything sent while a turn is in flight.
//
// A fake harness stands in for the SDKs so the protocol itself is what is tested
// rather than any one of them.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from '../src/main/agents/service'
import {
  HarnessRegistry,
  type ApprovalRequest,
  type HarnessRunOptions,
  type PromptAttachment
} from '../src/main/agents/harness'
import { SessionStore } from '../src/main/agents/store'

class FakeRun {
  resumeKey = 'thread-1'
  prompts: string[] = []
  steered: string[] = []
  steeredImages: PromptAttachment[][] = []
  interrupted = 0
  disposed = 0

  constructor(readonly options: HarnessRunOptions) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text)
    this.options.emit({ type: 'session.status_running' })
  }

  async steer(
    text: string,
    _deliverAs?: unknown,
    attachments: PromptAttachment[] = []
  ): Promise<void> {
    this.steered.push(text)
    this.steeredImages.push(attachments)
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1
  }

  async dispose(): Promise<void> {
    this.disposed += 1
  }

  /** Finish the turn, the way a real harness does when its loop settles. */
  finish(): void {
    this.options.emit({ type: 'session.status_idle', stopReason: 'end_turn' })
  }
}

/** A run that can also take slash commands, which is optional in the contract. */
class CommandRun extends FakeRun {
  commands: string[] = []

  async command(name: string, args: string): Promise<void> {
    this.commands.push(`${name} ${args}`.trim())
  }
}

interface Harness {
  service: AgentService
  store: SessionStore
  runs: FakeRun[]
  /** Where the sessions live, for tests that open a second service over them. */
  root: string
  cleanup: () => Promise<void>
}

/** Let the service's own promise chains settle before asserting on them. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'grove-agent-service-'))
  return openService(root)
}

/**
 * A service over sessions already on disk — what grove does on every start, and
 * what a test needs to check that something outlives a restart.
 */
function openService(root: string): Harness {
  const store = new SessionStore(root)
  const harnesses = new HarnessRegistry()
  const runs: FakeRun[] = []

  // Several of them, so switching harness — and a harness that can run commands
  // against one that cannot — can be tested for what they actually do.
  for (const id of ['fake', 'other', 'commanding']) {
    harnesses.register({
      id,
      label: id,
      description: '',
      icon: 'grove:test',
      capabilities: {
        approvals: true,
        interrupt: true,
        liveModelSwitch: true,
        thinking: true,
        steering: true,
        groveTools: true,
        groveMode: true,
        attachments: true
      },
      probe: async () => ({ available: true, detail: null }),
      offering: async () => ({
        tools: [],
        commands: [],
        skills: [],
        models: [
          {
            key: `${id}-model`,
            label: `${id}-model`,
            routes: [{ provider: id, id: `${id}-model` }]
          }
        ],
        default: { provider: id, model: `${id}-model` }
      }),
      start: async (options) => {
        const run = id === 'commanding' ? new CommandRun(options) : new FakeRun(options)
        runs.push(run)
        return run
      },
      intentOf: () => null
    })
  }

  const service = new AgentService({
    store,
    harnesses,
    tools: () => [],
    publish: () => {},
    defaultHarness: () => 'fake'
  })

  return {
    service,
    store,
    runs,
    root,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function say(text: string): { type: 'user.message'; content: { type: 'text'; text: string }[] } {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

/** A permission request as ACP sends one. */
function approvalRequest(
  toolCallId: string,
  name: string,
  rawInput: Record<string, unknown>
): ApprovalRequest {
  return { sessionId: 'harness-1', toolCall: { toolCallId, name, rawInput }, options: [] }
}

describe('AgentService', () => {
  test('the first message starts a run on the session harness', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      expect(session.harness).toBe('fake')

      await service.send(session.id, [say('hello')])
      expect(runs).toHaveLength(1)
      expect(runs[0].prompts).toEqual(['hello'])
    } finally {
      await cleanup()
    }
  })

  test('an unnamed session is named after its first prompt, and keeps that name', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        title: 'Session 2'
      })
      await service.send(session.id, [say('Fix the tab strip overflow\nIt clips the last tab')])
      await service.send(session.id, [say('and the close button')])

      const [listed] = await service.listSessions()
      expect(listed.title).toBe('Fix the tab strip overflow')
      expect(listed.preview).toEqual({ from: 'user', text: 'and the close button' })
    } finally {
      await cleanup()
    }
  })

  test('a session somebody named keeps its name', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        title: 'Inline edits'
      })
      await service.send(session.id, [say('rewrite this')])
      expect((await service.getSession(session.id)).title).toBe('Inline edits')
    } finally {
      await cleanup()
    }
  })

  test('a cleared session is named after the first prompt of its new conversation', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('Fix the tab strip overflow')])
      runs[0].finish()
      await settle()

      // The harness moved to a new, empty conversation (`/clear`).
      runs[0].options.emit({ type: 'session_changed', sessionId: 'thread-cleared' })
      await settle()
      expect((await service.getSession(session.id)).title).toBe('Session')

      await service.send(session.id, [say('Rename the settings pane')])
      expect((await service.getSession(session.id)).title).toBe('Rename the settings pane')
    } finally {
      await cleanup()
    }
  })

  test('a session somebody named keeps its name across a clear', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        title: 'Inline edits'
      })
      await service.send(session.id, [say('rewrite this')])
      runs[0].finish()
      await settle()

      runs[0].options.emit({ type: 'session_changed', sessionId: 'thread-cleared' })
      await settle()
      await service.send(session.id, [say('something else')])
      expect((await service.getSession(session.id)).title).toBe('Inline edits')
    } finally {
      await cleanup()
    }
  })

  test('a new session starts on the model its harness recommends', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      expect(session.provider).toBe('fake')
      expect(session.model).toBe('fake-model')
    } finally {
      await cleanup()
    }
  })

  test('an explicitly named model wins over the harness default', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        provider: 'chosen',
        model: 'chosen-model'
      })
      expect(session.provider).toBe('chosen')
      expect(session.model).toBe('chosen-model')
    } finally {
      await cleanup()
    }
  })

  test('the harness-native id is stored so a restart can resume', async () => {
    const { service, store, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('hello')])

      expect((await store.require(session.id)).resumeKey).toBe('thread-1')
    } finally {
      await cleanup()
    }
  })

  test('a conversation id the run changes mid-flight is stored', async () => {
    const { service, store, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('hello')])

      // What `/clear` does: the harness drops the conversation for a new one.
      runs[0].resumeKey = 'thread-2'
      runs[0].finish()
      await settle()

      expect((await store.require(session.id)).resumeKey).toBe('thread-2')
    } finally {
      await cleanup()
    }
  })

  test('a steer reaches a running turn, a follow-up waits for the next one', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])

      await service.send(session.id, [{ ...say('urgent'), deliverAs: 'steer' }])
      await service.send(session.id, [{ ...say('later'), deliverAs: 'followUp' }])

      expect(runs[0].steered).toEqual(['urgent'])
      expect(runs[0].prompts).toEqual(['first'])
      expect(service.queueOf(session.id).map((message) => message.text)).toEqual(['later'])

      runs[0].finish()
      await settle()
      expect(runs[0].prompts).toEqual(['first', 'later'])
    } finally {
      await cleanup()
    }
  })

  test('a steer an interrupted turn never took up starts the next turn', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      await service.send(session.id, [{ ...say('urgent'), deliverAs: 'steer' }])

      await service.send(session.id, [{ type: 'user.interrupt' }])
      runs[0].options.emit({ type: 'session.status_idle', stopReason: 'aborted' })
      await settle()

      expect(runs[0].interrupted).toBe(1)
      expect(runs[0].prompts).toEqual(['first', 'urgent'])
    } finally {
      await cleanup()
    }
  })

  test('a message sent with an interrupt goes out with everything waiting, as one message', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      await service.send(session.id, [{ ...say('urgent'), deliverAs: 'steer' }])
      await service.send(session.id, [{ ...say('later'), deliverAs: 'followUp' }])

      await service.send(session.id, [
        { ...say('and this'), deliverAs: 'steer' },
        { type: 'user.interrupt' }
      ])
      runs[0].options.emit({ type: 'session.status_idle', stopReason: 'aborted' })
      await settle()

      expect(runs[0].interrupted).toBe(1)
      expect(runs[0].prompts).toEqual(['first', 'urgent\n\nand this\n\nlater'])
      expect(service.queueOf(session.id)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('a steer hands its images to the running turn', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      const blob = await service.putBlob(session.id, new Uint8Array([1, 2, 3]), 'image/png')
      await service.send(session.id, [
        {
          type: 'user.message',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', ref: blob.ref, mediaType: 'image/png' }
          ],
          deliverAs: 'steer'
        }
      ])

      expect(runs[0].steered).toEqual(['look at this'])
      expect(runs[0].steeredImages).toEqual([[{ mediaType: 'image/png', data: 'AQID' }]])
    } finally {
      await cleanup()
    }
  })

  test('taking back a steer stops the turn and does not send it again', async () => {
    const { service, store, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      await service.send(session.id, [{ ...say('urgent'), deliverAs: 'steer' }])
      const steered = store
        .peekEvents(session.id)
        .filter((event) => event.type === 'user.message')
        .at(-1)

      await service.send(session.id, [{ type: 'user.unqueue', messageId: steered?.id ?? '' }])
      runs[0].options.emit({ type: 'session.status_idle', stopReason: 'aborted' })
      await settle()

      expect(runs[0].interrupted).toBe(1)
      expect(runs[0].prompts).toEqual(['first'])
    } finally {
      await cleanup()
    }
  })

  test('a steer the model already took up is not sent again after an interrupt', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      await service.send(session.id, [{ ...say('urgent'), deliverAs: 'steer' }])
      runs[0].options.emit({
        type: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'reply-after-steer',
          content: { type: 'text', text: 'on it' }
        }
      })

      await service.send(session.id, [{ type: 'user.interrupt' }])
      runs[0].options.emit({ type: 'session.status_idle', stopReason: 'aborted' })
      await settle()

      expect(runs[0].prompts).toEqual(['first'])
    } finally {
      await cleanup()
    }
  })

  test('an unqueued message is never delivered', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      await service.send(session.id, [{ ...say('later'), deliverAs: 'followUp' }])

      const [queued] = service.queueOf(session.id)
      await service.send(session.id, [{ type: 'user.unqueue', messageId: queued.id }])
      runs[0].finish()
      await settle()

      expect(runs[0].prompts).toEqual(['first'])
    } finally {
      await cleanup()
    }
  })

  test('a tool call parks until it is answered, and is announced as pending', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])

      const confirm = service['requestApproval'](
        session.id,
        approvalRequest('call-1', 'write', { path: 'a.ts' })
      )
      const snapshot = await service.getSession(session.id)
      expect(snapshot.pendingApprovals).toEqual(['call-1'])

      await service.send(session.id, [
        { type: 'user.tool_confirmation', toolUseId: 'call-1', result: 'allow' }
      ])
      expect(await confirm).toEqual({ result: 'allow' })
      expect((await service.getSession(session.id)).pendingApprovals).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('always_session answers the rest of that tool’s calls without asking', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])

      const first = service['requestApproval'](session.id, approvalRequest('call-1', 'write', {}))
      await service.send(session.id, [
        { type: 'user.tool_confirmation', toolUseId: 'call-1', result: 'always_session' }
      ])
      expect(await first).toEqual({ result: 'always_session' })

      const second = await service['requestApproval'](
        session.id,
        approvalRequest('call-2', 'write', {})
      )
      expect(second).toEqual({ result: 'allow' })
    } finally {
      await cleanup()
    }
  })

  test('a parked call reaches the log once, as the request the harness made', async () => {
    const { service, store, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])

      void service['requestApproval'](session.id, approvalRequest('call-1', 'write', {}))
      await settle()

      const events = await store.eventsSince(session.id, 0)
      const requests = events.filter((event) => event.type === 'permission')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ request: { toolCall: { toolCallId: 'call-1' } } })
    } finally {
      await cleanup()
    }
  })

  test('lets an untouched session change harness, and pins one that has answered', async () => {
    const { service, store, cleanup } = await setup()
    try {
      const fresh = await service.createSession({ workspace: '/tmp/worktree' })
      await service.updateSession(fresh.id, { harness: 'other' })
      expect((await store.require(fresh.id)).harness).toBe('other')

      const started = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(started.id, [say('go')])

      await expect(service.updateSession(started.id, { harness: 'other' })).rejects.toThrow(
        'once a session has started'
      )
      expect((await store.require(started.id)).harness).toBe(started.harness)
    } finally {
      await cleanup()
    }
  })

  test('a cleared conversation frees the harness until a message reaches the new one', async () => {
    const { service, store, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])
      runs[0].finish()
      await settle()

      // The harness moved to a new, empty conversation (`/clear`).
      runs[0].options.emit({ type: 'session_changed', sessionId: 'thread-cleared' })
      await settle()
      await service.updateSession(session.id, { harness: 'other' })
      expect((await store.require(session.id)).harness).toBe('other')

      await service.send(session.id, [say('carry on')])
      await expect(service.updateSession(session.id, { harness: 'fake' })).rejects.toThrow(
        'once a session has started'
      )
    } finally {
      await cleanup()
    }
  })

  test('an attached file slice reaches the harness as tagged text', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [
        {
          type: 'user.message',
          content: [
            { type: 'text', text: 'explain this' },
            { type: 'file', path: 'src/a.ts', startLine: 12, endLine: 13, text: 'a\nb' }
          ]
        }
      ])

      expect(runs[0].prompts).toEqual([
        'explain this\n<file path="src/a.ts" lines="12-13">\na\nb\n</file>'
      ])
    } finally {
      await cleanup()
    }
  })

  test('a slash command reaches a harness that can run one', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        harness: 'commanding'
      })
      await service.send(session.id, [{ type: 'user.command', name: 'review', args: 'the diff' }])

      expect((runs[0] as CommandRun).commands).toEqual(['review the diff'])
    } finally {
      await cleanup()
    }
  })

  test('a harness without commands says so instead of dropping the ask', async () => {
    const { service, store, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [{ type: 'user.command', name: 'review', args: '' }])

      const events = await store.eventsSince(session.id, 0)
      const notice = events.find((event) => event.type === 'session.notice')
      expect(notice).toMatchObject({ message: '"/review" is not supported by this harness' })
    } finally {
      await cleanup()
    }
  })

  /** Resolves once a `!` command's result is on the session's log; the command runs unawaited. */
  function shellResultOf(service: AgentService, sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const stop = service.observe(sessionId, (event) => {
        if (event.type !== 'session.shell_result') return
        stop()
        resolve()
      })
    })
  }

  test('a shell command runs in grove and lands on the log, whatever the harness', async () => {
    const { service, store, runs, cleanup } = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'grove-agent-shell-'))
    try {
      const session = await service.createSession({ workspace })
      const finished = shellResultOf(service, session.id)
      await service.send(session.id, [{ type: 'user.shell', command: 'echo hello', share: false }])
      await finished

      const events = await store.eventsSince(session.id, 0)
      const result = events.find((event) => event.type === 'session.shell_result')
      expect(result).toMatchObject({ command: 'echo hello', exitCode: 0, share: false })
      expect((result as { output: string }).output.trim()).toBe('hello')
      // A private command is the user looking something up: no run, no turn.
      expect(runs).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await cleanup()
    }
  })

  test('a shared shell command sent to the background goes to the agent when it exits', async () => {
    const { service, runs, cleanup } = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'grove-agent-shell-'))
    try {
      const session = await service.createSession({ workspace })
      const finished = shellResultOf(service, session.id)
      await service.send(session.id, [
        { type: 'user.shell', command: 'sleep 0.2; echo ready', share: true }
      ])
      await Bun.sleep(50)
      expect(service.backgroundShell(session.id)).toBe(true)
      await finished
      await settle()

      expect(runs[0].prompts[0]).toBe(
        '[Background command finished]\n<shell-command outcome="exit 0">\n$ sleep 0.2; echo ready\nready\n\n</shell-command>'
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await cleanup()
    }
  })

  test('a shared shell command rides along with the next message, once', async () => {
    const { service, runs, cleanup } = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'grove-agent-shell-'))
    try {
      const session = await service.createSession({ workspace })
      const finished = shellResultOf(service, session.id)
      await service.send(session.id, [{ type: 'user.shell', command: 'echo hello', share: true }])
      await finished
      expect(runs).toHaveLength(0)

      await service.send(session.id, [say('fix it')])
      expect(runs[0].prompts[0]).toBe(
        '<shell-command outcome="exit 0">\n$ echo hello\nhello\n\n</shell-command>\nfix it'
      )

      runs[0].finish()
      await settle()
      await service.send(session.id, [say('and again')])
      expect(runs[0].prompts[1]).toBe('and again')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await cleanup()
    }
  })

  test('shell output still waiting survives a restart', async () => {
    const first = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'grove-agent-shell-'))
    try {
      const session = await first.service.createSession({ workspace })
      await first.service.send(session.id, [
        { type: 'user.shell', command: 'echo hello', share: true }
      ])
      await settle()

      // What is waiting is read off the log, so a service that has never seen
      // the command still hands it over with the next message.
      const second = openService(first.root)
      await second.service.send(session.id, [say('fix it')])
      expect(second.runs[0].prompts[0]).toContain('$ echo hello')
      expect(second.runs[0].prompts[0]).toEndWith('fix it')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await first.cleanup()
    }
  })

  test('a private shell command is kept from the model', async () => {
    const { service, runs, cleanup } = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'grove-agent-shell-'))
    try {
      const session = await service.createSession({ workspace })
      await service.send(session.id, [{ type: 'user.shell', command: 'echo secret', share: false }])
      await service.send(session.id, [say('carry on')])

      expect(runs[0].prompts).toEqual(['carry on'])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await cleanup()
    }
  })

  test('a session without a workspace is refused', async () => {
    const { service, cleanup } = await setup()
    try {
      await expect(service.createSession({})).rejects.toThrow('a session needs a workspace')
    } finally {
      await cleanup()
    }
  })
})
