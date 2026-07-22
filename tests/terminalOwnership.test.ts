import { describe, it, expect } from 'bun:test'
import { RouteRegistry } from '../src/main/api/registry'
import { ApiDispatcher } from '../src/main/api/dispatcher'
import { registerTerminalsRoutes } from '../src/main/api/routes/terminals'
import type { ClientRecord } from '../src/main/api/clients'
import type { PermissionBroker } from '../src/main/api/broker'
import type { Worktree } from '../src/shared/types'

function client(id: string): ClientRecord {
  return {
    key: `plugin:${id}`,
    kind: 'plugin',
    id,
    name: id,
    source: 'user',
    declaredScopes: ['terminal.exec']
  }
}

function build(): {
  dispatcher: ApiDispatcher
  tap: ReturnType<typeof registerTerminalsRoutes>
  written: string[]
  killed: string[]
} {
  const registry = new RouteRegistry()
  const written: string[] = []
  const killed: string[] = []
  let counter = 0
  const tap = registerTerminalsRoutes(registry, {
    create: () => {
      counter += 1
      return `term-${counter}`
    },
    write: (terminalId, data) => written.push(`${terminalId}:${data}`),
    resize: () => {},
    kill: (terminalId) => killed.push(terminalId),
    announce: () => {}
  })
  const dispatcher = new ApiDispatcher({
    registry,
    broker: { ensure: async () => {} } as unknown as PermissionBroker,
    findWorktree: () => ({ id: 'wt', path: '/tmp/wt', branch: 'main' }) as Worktree
  })
  return { dispatcher, tap, written, killed }
}

let callCounter = 0
function invoke(
  dispatcher: ApiDispatcher,
  who: ClientRecord,
  method: string,
  params: Record<string, unknown>,
  emit?: (chunk: unknown) => void
): Promise<unknown> {
  callCounter += 1
  return dispatcher.invoke(who, `c${callCounter}`, method, params, { transport: 'worker', emit })
}

describe('terminal ownership', () => {
  it('owner can write and kill; others cannot', async () => {
    const { dispatcher, written, killed } = build()
    const owner = client('owner')
    const intruder = client('intruder')
    const { terminalId } = (await invoke(dispatcher, owner, 'terminals.create', {})) as {
      terminalId: string
    }
    await invoke(dispatcher, owner, 'terminals.write', { terminalId, data: 'ls\n' })
    expect(written).toEqual([`${terminalId}:ls\n`])

    await expect(
      invoke(dispatcher, intruder, 'terminals.write', { terminalId, data: 'evil' })
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      invoke(dispatcher, intruder, 'terminals.kill', { terminalId })
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      invoke(dispatcher, intruder, 'terminals.read', { terminalId })
    ).rejects.toMatchObject({ code: 'invalid' })

    await invoke(dispatcher, owner, 'terminals.kill', { terminalId })
    expect(killed).toEqual([terminalId])
  })

  it('create with a command writes it to the pty', async () => {
    const { dispatcher, written } = build()
    const owner = client('owner')
    const { terminalId } = (await invoke(dispatcher, owner, 'terminals.create', {
      command: 'echo hi'
    })) as { terminalId: string }
    expect(written).toEqual([`${terminalId}:echo hi\n`])
  })

  it('read streams buffered backlog, live data, and ends on exit', async () => {
    const { dispatcher, tap } = build()
    const owner = client('owner')
    const { terminalId } = (await invoke(dispatcher, owner, 'terminals.create', {})) as {
      terminalId: string
    }
    tap.onData(terminalId, 'before-read')
    const chunks: unknown[] = []
    const reading = invoke(dispatcher, owner, 'terminals.read', { terminalId }, (chunk) =>
      chunks.push(chunk)
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    tap.onData(terminalId, 'live')
    tap.onExit(terminalId, 0)
    await reading
    expect(chunks.flat()).toEqual([{ data: 'before-read' }, { data: 'live' }, { exitCode: 0 }])
  })

  it('data for unowned terminals is ignored by the tap', () => {
    const { tap } = build()
    // A user terminal (never created through the API) must not be buffered.
    expect(() => tap.onData('term-999', 'secret')).not.toThrow()
  })
})
