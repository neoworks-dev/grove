import { describe, expect, test } from 'bun:test'
import { appEnvironment, runtimeBase, sessionPaths } from '../scripts/qa/environment.ts'

const checkout = '/work/grove/.worktrees/500-native-qa'
const paths = sessionPaths(checkout, `${checkout}/.grove-qa`, '/run/user/1000')

/** The environment of a user in a Wayland session, with their own suite daemon. */
const userEnvironment = {
  HOME: '/home/someone',
  PATH: '/usr/bin',
  WAYLAND_DISPLAY: 'wayland-1',
  DISPLAY: ':1',
  HYPRLAND_INSTANCE_SIGNATURE: 'abc',
  XDG_CONFIG_HOME: '/home/someone/.config',
  XDG_RUNTIME_DIR: '/run/user/1000',
  NEO_SOCKET: '/run/user/1000/neo/bus.sock'
}

const environment = appEnvironment(userEnvironment, {
  checkout,
  paths,
  display: ':7',
  suite: '/work/neoworks-harness/bin/neo'
})

describe('appEnvironment', () => {
  test('moves every directory the app, sidecar and daemon write to into the profile', () => {
    const moved = [
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'TMPDIR',
      'GROVE_SIDECAR_DATA',
      'NEO_DATA_DIR'
    ]
    for (const name of moved) {
      expect(environment[name].startsWith(paths.profile)).toBe(true)
    }
  })

  test('gives the session its own daemon socket, never the user\'s', () => {
    expect(environment.NEO_SOCKET).not.toBe(userEnvironment.NEO_SOCKET)
    expect(environment.NEO_SOCKET.startsWith(paths.runtime)).toBe(true)
    expect(environment.XDG_RUNTIME_DIR).toBe(paths.runtime)
  })

  test('keeps the daemon socket short enough for a Unix socket path', () => {
    expect(environment.NEO_SOCKET.length).toBeLessThan(100)
  })

  test('opens the window on the session display over X11, not on the user\'s desktop', () => {
    expect(environment.DISPLAY).toBe(':7')
    expect(environment.WAYLAND_DISPLAY).toBeUndefined()
    expect(environment.HYPRLAND_INSTANCE_SIGNATURE).toBeUndefined()
  })

  test('runs this checkout\'s sidecar, whatever checkout the host was built in', () => {
    expect(environment.GROVE_SIDECAR).toBe(`${checkout}/src/main/sidecar/index.ts`)
  })

  test('opens the demo repo', () => {
    expect(environment.GROVE_REPO).toBe(paths.demoRepo)
  })
})

describe('sessionPaths', () => {
  test('names the runtime directory after the checkout, so two worktrees never share one', () => {
    const other = sessionPaths('/work/grove', '/work/grove/.grove-qa', '/run/user/1000')
    expect(other.runtime).not.toBe(paths.runtime)
  })
})

describe('runtimeBase', () => {
  test('falls back to the temp directory without a runtime directory', () => {
    expect(runtimeBase({ XDG_RUNTIME_DIR: '/run/user/5' })).toBe('/run/user/5')
    expect(runtimeBase({})).toBe('/tmp')
  })
})
