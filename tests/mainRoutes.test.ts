// The main-process IPC surface is 19 route plugins on a kernel context. This
// pins the two properties the split has to keep: every channel the preload
// bridge invokes gets registered, and unloading the plugins removes all of them.
//
// Electron is stubbed so the routes can mount outside an Electron runtime; the
// handlers themselves are never invoked here.

import { describe, it, expect, mock } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { electronStub, ipcHandlers as handlers } from './electronStub'

mock.module('electron', () => electronStub)

// Stand-ins for the subsystems. Only the members touched while a route plugin
// mounts need to exist; the handlers themselves are never called here.
const SERVICE_STUBS: Record<string, unknown> = {
  workbench: {},
  supervisor: {},
  checkpoints: {},
  review: {},
  settings: {},
  terminals: {},
  nvim: {},
  lsp: {},
  watcher: {},
  chat: {},
  actions: {},
  nib: {},
  nibReview: {},
  plugins: { registry: { loadAll: async () => [] } },
  apps: {}
}

/** Channels the renderer can invoke, read straight off the preload bridge. */
function preloadChannels(): string[] {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'preload', 'index.ts'), 'utf8')
  const found = source.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)
  return [...new Set([...found].map((match) => match[1]))]
}

// Imported after the mock is in place, so the routes bind to the stub above
// rather than to electron's real module (which has no ipcMain outside Electron).
const { Context } = await import('@neoworks/extension-system')
const { routePlugins } = await import('../src/main/routes')

describe('main route plugins', () => {
  it('registers every channel the preload bridge invokes', async () => {
    handlers.clear()
    const root = new Context()
    await root.plugin({
      name: 'test/services',
      apply(ctx) {
        for (const [key, value] of Object.entries(SERVICE_STUBS)) ctx.provide(key, value)
      }
    })
    await Promise.all(routePlugins.map((plugin) => root.plugin(plugin)))

    const missing = preloadChannels().filter((channel) => !handlers.has(channel))
    expect(missing).toEqual([])
  })

  it('removes every handler when the routes unload', async () => {
    handlers.clear()
    const root = new Context()
    await root.plugin({
      name: 'test/services',
      apply(ctx) {
        for (const [key, value] of Object.entries(SERVICE_STUBS)) ctx.provide(key, value)
      }
    })
    const fibers = await Promise.all(routePlugins.map((plugin) => root.plugin(plugin)))
    expect(handlers.size).toBeGreaterThan(100)

    for (const fiber of fibers) await fiber.dispose()
    expect(handlers.size).toBe(0)
  })

  it('leaves the routes PENDING while their services are missing', async () => {
    handlers.clear()
    const root = new Context()
    await Promise.all(routePlugins.map((plugin) => root.plugin(plugin)))
    // Only the two domains that inject nothing (editor catalog, misc) can run.
    expect(handlers.size).toBeLessThan(10)
  })
})
