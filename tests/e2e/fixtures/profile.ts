// An isolated grove profile: where a test instance keeps everything it writes.
//
// Every path grove persists to hangs off Electron's `userData`, and on Linux
// that is `$XDG_CONFIG_HOME/grove`. Redirecting that one variable therefore
// moves the whole profile together — settings, the agent event log, blob
// storage, pairing tokens, the API socket and its discovery file, and the nvim
// runtime that `nvimPaths.ts` builds under userData. The user's own
// ~/.config/grove is never opened, so an instance they are running keeps its
// sessions and editor state while a test runs beside it.
//
// Used from two places: `scripts/test-env.ts`, which keeps one profile around
// to drive by hand, and the Playwright fixture, which makes a throwaway one per
// run.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PLUGIN_PERMISSIONS } from '../../../sdk/src/protocol'
import {
  DEMO_BRANCH,
  createDemoRepo,
  demoWorktreePathFor,
  type DemoRepo
} from './demoRepo'

/** The app id the debug harness and the e2e tests connect under. */
export const DEBUG_APP_ID = 'grove-debug'

export interface GroveProfile {
  /** The directory everything below lives in. */
  root: string
  /** What grove writes its profile into, via XDG_CONFIG_HOME. */
  configHome: string
  /** Electron's userData for that profile. */
  userData: string
  /** The demo repository grove opens. */
  demoRepo: string
  /** The variables to launch or drive the app with. */
  env: Record<string, string>
}

export function profileAt(root: string): GroveProfile {
  const configHome = join(root, 'config')
  return {
    root,
    configHome,
    // Electron keys userData by app name, which is `grove` from package.json.
    userData: join(configHome, 'grove'),
    demoRepo: join(root, 'demo'),
    env: {
      XDG_CONFIG_HOME: configHome,
      // nvim's runtime already lives under userData, but a stray tool reading
      // the real ones would be reaching outside the profile.
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      // The debug routes only mount under this flag.
      GROVE_DEBUG: '1'
    }
  }
}

/**
 * Build the profile and the demo repo, leaving the app ready to launch.
 *
 * Both permission gates are pre-answered here, so nothing the tests do stops on
 * a dialog. Grove caches those files in memory the first time it reads them, so
 * this only takes effect on the next launch.
 */
export async function prepareProfile(profile: GroveProfile): Promise<DemoRepo> {
  for (const directory of Object.values(profile.env)) {
    if (directory.startsWith(profile.root)) await mkdir(directory, { recursive: true })
  }
  await mkdir(profile.userData, { recursive: true })

  const demo = await reuseOrCreateDemoRepo(profile.demoRepo)
  // grove stores the repo root as git reports it; a symlinked path would not
  // match the key it later looks its own state up under.
  const canonicalRoot = await realpath(demo.root)
  await seedWorkbenchState(profile.userData, canonicalRoot)
  await prePair(profile, DEBUG_APP_ID)

  return { ...demo, root: canonicalRoot }
}

/**
 * The demo repo as it stands, building it first if this is a cold profile.
 *
 * Rebuilding one an app already has open loses whatever the last session was
 * looking at, and `prepare` runs on every launch.
 */
async function reuseOrCreateDemoRepo(root: string): Promise<DemoRepo> {
  if (await exists(join(root, '.git'))) {
    return { root, worktreePath: demoWorktreePathFor(root), branch: DEMO_BRANCH }
  }
  return createDemoRepo(root)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Point the profile at the demo repo, so grove opens it on launch.
 *
 * Only `lastRepoPath` is written. The per-repo record has a dozen fields that
 * are read without a default, so a partial one seeded from here would crash the
 * open and would drift the moment a field is added — grove builds its own
 * through `emptyRepoState()`. The intro page stays away because the demo repo
 * has an AGENTS.md, which is what grove reads as "already set up".
 */
async function seedWorkbenchState(userData: string, repoPath: string): Promise<void> {
  const statePath = join(userData, 'workbench-state.json')
  const state = await readJson(statePath)
  state.lastRepoPath = repoPath
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * Grant an app id its pairing token up front, so connecting raises no dialog.
 *
 * Pairing is a real trust boundary and is meant to be interactive — but this
 * profile is a scratch one holding only the demo repo, and a test run cannot
 * click the dialog. Both sides of the handshake are written: the sha256 of the
 * token into grove's own store, and the token itself into the client token
 * store the SDK reads, which is keyed off the XDG_CONFIG_HOME this profile
 * already redirects.
 */
async function prePair(profile: GroveProfile, appId: string): Promise<void> {
  const token = randomBytes(32).toString('hex')
  const now = new Date().toISOString()

  const storePath = join(profile.userData, 'external-apps.json')
  const store = await readJson(storePath)
  const apps = (store.apps as Record<string, unknown>) ?? {}
  store.apps = {
    ...apps,
    [appId]: {
      appId,
      name: 'Grove Test Environment',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      // Every scope, because requesting one that was not granted would put the
      // dialog back as a scope escalation.
      grantedScopes: PLUGIN_PERMISSIONS,
      createdAt: now,
      lastSeenAt: now
    }
  }
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8')

  const tokenPath = join(profile.configHome, 'grove', 'tokens', appId)
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 })
  await writeFile(tokenPath, token, { encoding: 'utf8', mode: 0o600 })
  await chmod(tokenPath, 0o600)

  await grantEveryCapability(profile, `app:${appId}`)
}

/**
 * Pre-answer the permission broker for a paired client.
 *
 * Pairing only establishes who the client is; each capability it then reaches
 * for raises its own allow/deny dialog. Without this the first
 * `debug.nvim.lua` call sits on a dialog nobody is there to click.
 */
async function grantEveryCapability(profile: GroveProfile, clientKey: string): Promise<void> {
  const grantsPath = join(profile.userData, 'plugin-grants.json')
  const store = await readJson(grantsPath)
  const clients = (store.plugins as Record<string, unknown>) ?? {}

  const permissions: Record<string, 'granted'> = {}
  for (const permission of PLUGIN_PERMISSIONS) permissions[permission] = 'granted'

  store.plugins = {
    ...clients,
    [clientKey]: { permissions, fsScopes: [profile.demoRepo] }
  }
  await writeFile(grantsPath, JSON.stringify(store, null, 2), 'utf8')
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
