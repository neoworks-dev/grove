import { describe, it, expect, mock } from 'bun:test'

// nvim.ts pulls in nvimPaths, which imports electron's `app` at load. Stub it so
// the manager can be constructed under bun's non-electron test runtime.
mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd()
  }
}))

const { NeovimManager } = await import('../src/main/nvim')

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
