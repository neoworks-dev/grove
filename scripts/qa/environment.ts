// Where a QA session keeps everything, and the environment its app runs in.
//
// The session must never reach the user's own Grove: their settings, their data,
// their suite daemon and its agents. Every place native Grove and its sidecar
// read or write is chosen by an environment variable, so the session gets its own
// value for each of them, under one profile directory the harness owns.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionPaths {
  /** The profile: config, data, state, cache and temp, plus the demo repo. */
  profile: string
  /** The demo repository the app opens. */
  demoRepo: string
  /**
   * A short directory for sockets, under the user's runtime directory. Unix
   * socket paths are limited to about a hundred bytes, which a worktree path
   * already comes close to, so this one is named after a hash of the checkout.
   */
  runtime: string
}

/** The paths of the session a checkout runs, given its QA directory. */
export function sessionPaths(checkout: string, qaRoot: string, runtimeBase: string): SessionPaths {
  const profile = join(qaRoot, 'profile')
  const hash = createHash('sha1').update(checkout).digest('hex').slice(0, 10)
  return {
    profile,
    demoRepo: join(profile, 'demo'),
    runtime: join(runtimeBase, `grove-qa-${hash}`)
  }
}

/** Where a runtime directory can go: the user's, or the system temp directory without one. */
export function runtimeBase(environment: Record<string, string | undefined>): string {
  const runtime = environment.XDG_RUNTIME_DIR
  if (runtime !== undefined && runtime.length > 0) {
    return runtime
  }
  return '/tmp'
}

export interface AppEnvironmentOptions {
  checkout: string
  paths: SessionPaths
  display: string
  /** The `neo` executable the app starts its daemon with. */
  suite: string
}

/**
 * The environment the app runs in: the caller's, with every directory the app,
 * its sidecar and its suite daemon use moved into the profile, and the window
 * sent to the session's display over X11.
 */
export function appEnvironment(
  base: Record<string, string | undefined>,
  options: AppEnvironmentOptions
): Record<string, string> {
  const { checkout, paths, display, suite } = options
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) {
      continue
    }
    environment[name] = value
  }
  // Without these GPUI would open on the user's Wayland session instead of X11.
  delete environment.WAYLAND_DISPLAY
  delete environment.WAYLAND_SOCKET
  delete environment.HYPRLAND_INSTANCE_SIGNATURE
  delete environment.SWAYSOCK

  return {
    ...environment,
    DISPLAY: display,
    XDG_SESSION_TYPE: 'x11',
    XDG_CONFIG_HOME: join(paths.profile, 'config'),
    XDG_DATA_HOME: join(paths.profile, 'data'),
    XDG_STATE_HOME: join(paths.profile, 'state'),
    XDG_CACHE_HOME: join(paths.profile, 'cache'),
    XDG_RUNTIME_DIR: paths.runtime,
    TMPDIR: join(paths.profile, 'tmp'),
    GROVE_SIDECAR_DATA: join(paths.profile, 'data', 'grove-native'),
    // The binary has the checkout it was built in compiled into it; a host
    // copied from another checkout would otherwise run that one's sidecar.
    GROVE_SIDECAR: join(checkout, 'src', 'main', 'sidecar', 'index.ts'),
    GROVE_NEO: suite,
    NEO_SOCKET: join(paths.runtime, 'neo', 'bus.sock'),
    NEO_DATA_DIR: join(paths.profile, 'data', 'neo'),
    GROVE_REPO: paths.demoRepo,
    GROVE_OPEN: join(paths.demoRepo, 'README.md'),
    // `gh` keeps its login under XDG_CONFIG_HOME, which has just moved; without
    // this every GitHub surface reads as logged out. The demo repo's remote is a
    // sandbox for exactly this reason.
    GH_CONFIG_DIR: githubConfig(base),
    GROVE_DEBUG: '1'
  }
}

/** Where `gh` keeps its login: wherever the caller's points, else its default. */
function githubConfig(base: Record<string, string | undefined>): string {
  const configured = base.GH_CONFIG_DIR
  if (configured !== undefined && configured.length > 0) {
    return configured
  }
  return join(homedir(), '.config', 'gh')
}
