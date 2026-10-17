// The platform seam: the Electron host passes every call to the Electron API as before,
// the sidecar host answers what a process without a window can, and a route registered
// through the kernel lands wherever the installed host serves it.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@neoworks/extension-system'
import { route } from '../src/main/kernel/route'
import { installPlatform, platform, type Platform } from '../src/main/platform'
import { createElectronPlatform } from '../src/main/platform/electron'
import { createSidecarPlatform, defaultUserDataPath } from '../src/main/platform/sidecar'
import { StdioTransport } from '../src/main/sidecar/transport'

// Other test files read the platform too; put theirs back when this file is done.
let previous: Platform | null = null
try {
  previous = platform()
} catch {
  previous = null
}
afterAll(() => {
  if (previous) {
    installPlatform(previous)
  }
})

/** A sidecar platform over a transport that collects its frames, with its own data directory. */
function sidecarPlatform(): {
  host: Platform
  transport: StdioTransport
  frames: string[]
  logs: string[]
} {
  const frames: string[] = []
  const logs: string[] = []
  const transport = new StdioTransport({ write: (chunk: string) => frames.push(chunk) }, () => {})
  const host = createSidecarPlatform({
    transport,
    userDataPath: join(mkdtempSync(join(tmpdir(), 'grove-platform-')), 'data'),
    appPath: '/the/checkout',
    log: (message) => logs.push(message)
  })
  return { host, transport, frames, logs }
}

describe('electron platform', () => {
  test('asks the Electron API each time, so a changed answer is seen', () => {
    let userData = '/one'
    const electron = {
      app: {
        getPath: () => userData,
        isPackaged: true,
        getAppPath: () => '/app'
      }
    }
    const host = createElectronPlatform(electron as never)
    expect(host.userDataPath()).toBe('/one')
    userData = '/two'
    expect(host.userDataPath()).toBe('/two')
    expect(host.isPackaged()).toBe(true)
    expect(host.appPath()).toBe('/app')
  })

  test('routes go to ipcMain and come off it again', () => {
    const registered = new Map<string, unknown>()
    const electron = {
      ipcMain: {
        handle: (channel: string, handler: unknown) => registered.set(channel, handler),
        removeHandler: (channel: string) => registered.delete(channel)
      }
    }
    const host = createElectronPlatform(electron as never)
    const handler = (): number => 1
    const remove = host.handleRoute('a:b', handler)
    expect(registered.get('a:b')).toBe(handler)
    remove()
    expect(registered.has('a:b')).toBe(false)
  })

  test('events go to every window, and a message box answers with the button pressed', async () => {
    const sent: unknown[][] = []
    const windows = [1, 2].map((id) => ({
      webContents: { send: (...args: unknown[]) => sent.push([id, ...args]) }
    }))
    const electron = {
      BrowserWindow: { getAllWindows: () => windows },
      dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) }
    }
    const host = createElectronPlatform(electron as never)
    host.broadcast('event:x', { a: 1 })
    expect(sent).toEqual([
      [1, 'event:x', { a: 1 }],
      [2, 'event:x', { a: 1 }]
    ])
    const response = await host.showMessageBox({
      type: 'warning',
      title: 't',
      message: 'm',
      detail: 'd',
      buttons: ['No', 'Yes'],
      defaultId: 0,
      cancelId: 0
    })
    expect(response).toBe(1)
  })

  test('a protocol is handled until the returned function unhandles it', () => {
    const handled: string[] = []
    const electron = {
      protocol: {
        handle: (scheme: string) => handled.push(scheme),
        unhandle: (scheme: string) => handled.splice(handled.indexOf(scheme), 1)
      }
    }
    const host = createElectronPlatform(electron as never)
    const stop = host.handleProtocol('grove-file', () => new Response('ok'))
    expect(handled).toEqual(['grove-file'])
    stop()
    expect(handled).toEqual([])
  })
})

describe('sidecar platform', () => {
  test('keeps its data under its own directory, never Electron’s', () => {
    const { host } = sidecarPlatform()
    expect(existsSync(host.userDataPath())).toBe(true)
    expect(host.isPackaged()).toBe(false)
    expect(host.appPath()).toBe('/the/checkout')
    expect(defaultUserDataPath()).toContain('grove-native')
  })

  test('the data directory follows GROVE_SIDECAR_DATA, then the XDG data home', () => {
    const saved = { ...process.env }
    try {
      process.env.GROVE_SIDECAR_DATA = '/explicit'
      expect(defaultUserDataPath()).toBe('/explicit')
      delete process.env.GROVE_SIDECAR_DATA
      process.env.XDG_DATA_HOME = '/xdg'
      expect(defaultUserDataPath()).toBe('/xdg/grove-native')
    } finally {
      process.env = saved
    }
  })

  test('answers a dialog as a cancelled one, and says so', async () => {
    const { host, logs } = sidecarPlatform()
    const response = await host.showMessageBox({
      type: 'warning',
      title: 'Run setup commands?',
      message: 'm',
      detail: 'd',
      buttons: ["Don't run", 'Trust and run'],
      defaultId: 0,
      cancelId: 0
    })
    expect(response).toBe(0)
    expect(logs[0]).toContain("Don't run")
    expect(await host.pickDirectory()).toBeNull()
  })

  test('has no keychain, which is how credentials learn they cannot be stored', () => {
    const { host } = sidecarPlatform()
    expect(host.encryption.isAvailable()).toBe(false)
    expect(() => host.encryption.encrypt('secret')).toThrow('no keychain')
  })

  test('has no window to act on and nothing to evaluate script in', async () => {
    const { host } = sidecarPlatform()
    expect(host.windowOf({ sender: null } as never)).toBeNull()
    await expect(host.evaluateInRenderer('1 + 1')).rejects.toThrow('no renderer window')
  })

  test('routes and events go through the transport', () => {
    const { host, transport, frames } = sidecarPlatform()
    host.handleRoute('files:listDir', () => [])
    expect(transport.channels()).toEqual(['files:listDir'])
    host.broadcast('event:log', { line: 'hi' })
    expect(JSON.parse(frames[0])).toEqual({
      kind: 'event',
      channel: 'event:log',
      payload: { line: 'hi' }
    })
  })

  test('says a URL scheme is not served instead of pretending to', () => {
    const { host, logs } = sidecarPlatform()
    host.handleProtocol('grove-plugin', () => new Response('ok'))()
    expect(logs[0]).toContain('grove-plugin://')
  })
})

describe('route registration', () => {
  test('a route plugin registers through the installed platform and unloads from it', async () => {
    const { host, transport } = sidecarPlatform()
    installPlatform(host)
    const context = new Context()
    await context.plugin({
      name: 'test/routes',
      inject: [],
      apply(ctx: Context): void {
        route(ctx, 'test:ping', () => 'pong')
      }
    })
    expect(transport.channels()).toEqual(['test:ping'])
    await context.fiber.dispose()
    expect(transport.channels()).toEqual([])
  })
})
