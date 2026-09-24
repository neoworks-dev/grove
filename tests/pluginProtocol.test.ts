import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { electronStub } from './electronStub'
import type { PluginRegistry } from '../src/main/plugins/loader'

mock.module('electron', () => electronStub)

const { registerPluginProtocol } = await import('../src/main/plugins/protocol')

type Handler = (request: Request) => Promise<Response>

describe('grove-plugin protocol', () => {
  let handler: Handler
  const originalHandle = electronStub.protocol.handle

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'grove-plugin-'))
    await mkdir(join(root, 'viewer'))
    await writeFile(join(root, 'viewer', 'index.html'), '<!doctype html>')
    await writeFile(join(root, 'viewer', 'page.js'), 'export {}')
    const record = { id: 'qa.viewer', status: 'ready', root }
    const registry = {
      get: (pluginId: string) => (pluginId === record.id ? record : undefined)
    } as unknown as PluginRegistry
    electronStub.protocol.handle = (_scheme: string, registered: never): void => {
      handler = registered
    }
    registerPluginProtocol(registry)
  })

  afterAll(() => {
    electronStub.protocol.handle = originalHandle
  })

  it('serves a viewer page under a policy with no network', async () => {
    const response = await handler(new Request('grove-plugin://qa.viewer/viewer/index.html'))
    expect(response.headers.get('content-type')).toBe('text/html')
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain('script-src grove-plugin://qa.viewer ')
  })

  it("lets the sandboxed frame's module scripts load", async () => {
    const response = await handler(new Request('grove-plugin://qa.viewer/viewer/page.js'))
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('content-security-policy')).toBeNull()
  })

  it('does not serve a plugin that is not loaded', async () => {
    const response = await handler(new Request('grove-plugin://someone.else/viewer/index.html'))
    expect(response.status).toBe(404)
  })
})
