import { describe, it, expect } from 'bun:test'
import { RouteRegistry, type RouteContext } from '../src/main/api/registry'
import { registerClipboardRoutes } from '../src/main/api/routes/clipboard'

/** The routes over a clipboard that is just a string. */
function build(): { registry: RouteRegistry; clipboard: { text: string } } {
  const clipboard = { text: 'copied elsewhere' }
  const registry = new RouteRegistry()
  registerClipboardRoutes(registry, {
    writeText: (text) => {
      clipboard.text = text
    },
    readText: () => clipboard.text
  })
  return { registry, clipboard }
}

/** Runs a route's handler as a plugin would reach it. */
function call(registry: RouteRegistry, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const route = registry.get(method)
  if (!route) throw new Error(`route not registered: ${method}`)
  const context = { client: { key: 'plugin:test.plugin' } } as unknown as RouteContext
  return route.handler(args, context)
}

describe('clipboard routes', () => {
  it('gates writing and reading by separate scopes', () => {
    const { registry } = build()
    expect(registry.get('clipboard.writeText')?.scope).toBe('clipboard.write')
    expect(registry.get('clipboard.readText')?.scope).toBe('clipboard.read')
  })

  it('writes and reads plain text', async () => {
    const { registry, clipboard } = build()
    expect(await call(registry, 'clipboard.readText')).toBe('copied elsewhere')
    await call(registry, 'clipboard.writeText', { text: 'process output' })
    expect(clipboard.text).toBe('process output')
  })

  it('refuses anything but a string, and leaves the clipboard alone', async () => {
    const { registry, clipboard } = build()
    await expect(call(registry, 'clipboard.writeText', { text: 42 })).rejects.toMatchObject({
      code: 'invalid'
    })
    expect(clipboard.text).toBe('copied elsewhere')
  })
})
