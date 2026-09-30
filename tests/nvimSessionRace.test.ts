import { describe, it, expect, mock } from 'bun:test'
import { PassThrough } from 'node:stream'
import { electronStub } from './electronStub'

// nvim.ts pulls in nvimPaths, which imports electron's `app` at load. Stub it so
// the manager can be constructed under bun's non-electron test runtime.
mock.module('electron', () => electronStub)

const { NeovimManager } = await import('../src/main/nvim')
const { NvimRpc } = await import('../src/main/nvimRpc')

// A request/command aimed at a session that no longer exists (killed on quit,
// rebind, or crash-restart) is a benign teardown race — it must resolve quietly
// instead of throwing, or Electron logs each one as a handler error.
describe('NeovimManager gone-session tolerance', () => {
  const manager = new NeovimManager({
    onRedraw: () => {},
    onExit: () => {},
    onNotify: () => {}
  })

  it('request to an unknown session resolves to null', async () => {
    const result = await manager.request('nvim-does-not-exist', 'nvim_get_current_buf', [])
    expect(result).toBeNull()
  })

  it('command to an unknown session is a no-op', async () => {
    await expect(manager.command('nvim-does-not-exist', 'noop')).resolves.toBeUndefined()
  })

  it('still rejects a blocked non-api method before touching the session', async () => {
    await expect(manager.request('nvim-1', 'system', [])).rejects.toThrow('blocked non-api method')
  })
})

// The renderer kills its nvim on a worktree switch or when the pane goes away,
// and that can land while it is still waiting for nvim:attach. The kill rejects
// the pending attach with "nvim exited", which Electron logged as a handler
// error on every such switch.
describe('NeovimManager attach racing a kill', () => {
  /** A manager holding one session whose nvim never answers, as one busy starting up. */
  function managerWithSilentSession(id: string): InstanceType<typeof NeovimManager> {
    const manager = new NeovimManager({ onRedraw: () => {}, onExit: () => {}, onNotify: () => {} })
    const rpc = new NvimRpc(new PassThrough(), new PassThrough())
    const child = { kill: () => true, killed: false, exitCode: null }
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set(id, { child, rpc, pending: [], flushTimer: null, killedByUs: false })
    return manager
  }

  it('resolves quietly when the session is killed mid-attach', async () => {
    const manager = managerWithSilentSession('nvim-1')

    const attaching = manager.attach('nvim-1', 80, 24)
    manager.kill('nvim-1')

    await expect(attaching).resolves.toBeUndefined()
  })

  it('resolves quietly when the session was killed before attach arrived', async () => {
    const manager = managerWithSilentSession('nvim-1')
    manager.kill('nvim-1')

    await expect(manager.attach('nvim-1', 80, 24)).resolves.toBeUndefined()
  })
})
