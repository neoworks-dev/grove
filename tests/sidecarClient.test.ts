// The UI's sidecar client against a real transport, with a fake host between them that
// does what native/src/sidecar.rs does: writes request frames to the sidecar's stdin,
// sends replies back whole, and hands each event to whoever listens to its channel.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { encodeFrame } from '../sdk/src/frames'
import type { RpcMessage } from '../sdk/src/protocol'
import { extractChannels, renderChannels } from '../scripts/generate-sidecar-channels'
import {
  SidecarClient,
  type SidecarBridge,
  type SidecarExit,
  type SidecarStatus
} from '../native/sidecar-client/client'
import { workbenchChannels } from '../native/sidecar-client/channels'
import { createWorkbench } from '../native/sidecar-client/workbench'
import { StdioTransport } from '../src/main/sidecar/transport'

/** One line the sidecar printed, as the frame it carries. */
function parseFrame(line: string): RpcMessage {
  const frame: RpcMessage = JSON.parse(line)
  return frame
}

/** The host's relay in miniature, with a switch to make its stdin refuse writes. */
class FakeHost implements SidecarBridge {
  transport: StdioTransport
  private input = new PassThrough()
  private replyHandlers = new Set<(frame: RpcMessage) => void>()
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>()
  private exitHandlers = new Set<(exit: SidecarExit) => void>()
  private stdinBroken = false

  constructor() {
    this.transport = new StdioTransport({ write: (chunk) => this.relay(chunk) }, () => {})
    this.transport.listen(this.input, () => {})
  }

  /** Splits what the sidecar printed into frames and passes each one on, as the reader thread does. */
  private relay(chunk: string): void {
    for (const line of chunk.split('\n').filter((entry) => entry.length > 0)) {
      const frame = parseFrame(line)
      if (frame.kind === 'event') {
        this.eventHandlers.get(frame.channel)?.forEach((handler) => handler(frame.payload))
        continue
      }
      this.replyHandlers.forEach((handler) => handler(frame))
    }
  }

  send(frame: RpcMessage): Promise<unknown> {
    if (this.stdinBroken) {
      return Promise.reject(new Error('the sidecar is not running'))
    }
    this.input.write(encodeFrame(frame))
    return Promise.resolve(null)
  }

  onReply(handler: (frame: RpcMessage) => void): () => void {
    this.replyHandlers.add(handler)
    return () => this.replyHandlers.delete(handler)
  }

  onEvent(channel: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.eventHandlers.get(channel) ?? new Set()
    handlers.add(handler)
    this.eventHandlers.set(channel, handlers)
    return () => handlers.delete(handler)
  }

  onExit(handler: (exit: SidecarExit) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  status(): Promise<SidecarStatus> {
    return Promise.resolve({ state: 'running', pid: 1 })
  }

  /** The sidecar dies: its stdin is gone and the host says so. */
  crash(): void {
    this.stdinBroken = true
    this.exitHandlers.forEach((handler) =>
      handler({ code: 1, message: 'the sidecar exited with status 1' })
    )
  }
}

describe('sidecar client', () => {
  test('call resolves with what the route returned', async () => {
    const host = new FakeHost()
    host.transport.handleRoute('git:branchStatus', (_event, worktreeId: string) => ({
      worktreeId,
      ahead: 1
    }))
    const client = new SidecarClient(host)
    expect(await client.call('git:branchStatus', 'w1')).toEqual({ worktreeId: 'w1', ahead: 1 })
  })

  test('call rejects with the route’s error message', async () => {
    const host = new FakeHost()
    host.transport.handleRoute('repo:open', () => {
      throw new Error('not a git repository')
    })
    const client = new SidecarClient(host)
    await expect(client.call('repo:open', '/x')).rejects.toThrow('not a git repository')
  })

  test('calls in flight keep their own answers', async () => {
    const host = new FakeHost()
    host.transport.handleRoute('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 'slow'
    })
    host.transport.handleRoute('fast', () => 'fast')
    const client = new SidecarClient(host)
    const [slow, fast] = await Promise.all([client.call('slow'), client.call('fast')])
    expect([slow, fast]).toEqual(['slow', 'fast'])
  })

  test('on hears events pushed on its channel, and stops when unsubscribed', () => {
    const host = new FakeHost()
    const client = new SidecarClient(host)
    const heard: unknown[] = []
    const stop = client.on('event:fs-change', (payload) => heard.push(payload))
    host.transport.broadcast('event:fs-change', { relPath: 'a' })
    host.transport.broadcast('event:other', { relPath: 'ignored' })
    stop()
    host.transport.broadcast('event:fs-change', { relPath: 'b' })
    expect(heard).toEqual([{ relPath: 'a' }])
  })

  test('info lists the routes the sidecar serves', async () => {
    const host = new FakeHost()
    host.transport.handleRoute('git:branches', () => [])
    const client = new SidecarClient(host)
    expect((await client.info()).channels).toEqual(['git:branches'])
  })

  test('a call the host cannot deliver is rejected, not left waiting', async () => {
    const host = new FakeHost()
    const client = new SidecarClient(host)
    host.crash()
    await expect(client.call('git:branches')).rejects.toThrow('the sidecar is not running')
  })

  test('the sidecar exiting fails the calls waiting on it', async () => {
    const host = new FakeHost()
    host.transport.handleRoute('hangs', () => new Promise(() => {}))
    const client = new SidecarClient(host)
    const waiting = client.call('hangs')
    host.crash()
    await expect(waiting).rejects.toThrow('the sidecar exited with status 1')
  })

  test('onExit tells the UI how the sidecar ended', () => {
    const host = new FakeHost()
    const client = new SidecarClient(host)
    const exits: SidecarExit[] = []
    client.onExit((exit) => exits.push(exit))
    host.crash()
    expect(exits).toEqual([{ code: 1, message: 'the sidecar exited with status 1' }])
  })
})

describe('workbench over the sidecar', () => {
  test('a method calls the channel the preload invokes, with its arguments', async () => {
    const host = new FakeHost()
    const calls: unknown[][] = []
    host.transport.handleRoute('git:branchStatus', (_event, ...args) => {
      calls.push(args)
      return { ahead: 3 }
    })
    host.transport.handleRoute('files:listDir', (_event, ...args) => {
      calls.push(args)
      return []
    })
    const workbench = createWorkbench(new SidecarClient(host))
    expect(await workbench.git.branchStatus('w1')).toEqual({ ahead: 3 })
    await workbench.files.listDir('w1', 'src')
    expect(calls).toEqual([['w1'], ['w1', 'src']])
  })

  test('methods that sit directly on workbench, and those with unlike names, are mapped', () => {
    expect(workbenchChannels['openExternal']).toBe('shell:openExternal')
    expect(workbenchChannels['raiseWindow']).toBe('window:raise')
    expect(workbenchChannels['debugger.snapshot']).toBe('debug:snapshot')
  })

  test('on subscribes to a pushed event', () => {
    const host = new FakeHost()
    const workbench = createWorkbench(new SidecarClient(host))
    const heard: unknown[] = []
    workbench.on('event:recent-repos', (payload) => heard.push(payload))
    host.transport.broadcast('event:recent-repos', ['/a'])
    expect(heard).toEqual([['/a']])
  })

  test('what has no route says it is not available instead of failing silently', () => {
    const workbench = createWorkbench(new SidecarClient(new FakeHost()))
    expect(() => workbench.files.pathForFile({} as File)).toThrow('not available in the native app')
  })

  test('every route the preload invokes has a method, and the table is current', () => {
    const preload = readFileSync(join(import.meta.dir, '..', 'src', 'preload', 'index.ts'), 'utf8')
    const table = extractChannels(preload)
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(
      (match) => match[1]
    )
    expect(Object.values(table).sort()).toEqual([...new Set(invoked)].sort())
    const written = readFileSync(
      join(import.meta.dir, '..', 'native', 'sidecar-client', 'channels.ts'),
      'utf8'
    )
    // Regenerate with `bun run native:channels` when this fails.
    expect(written).toBe(renderChannels(table))
  })
})
