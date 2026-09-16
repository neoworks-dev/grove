// An isolated grove profile, for driving the app without touching the real one.
//
// Everything grove persists hangs off Electron's `userData`, and on Linux that
// is `$XDG_CONFIG_HOME/grove`. Pointing XDG_CONFIG_HOME at a scratch directory
// therefore moves the whole profile in one step: settings, the agent event
// log, blob storage, pairing tokens, the API socket and its discovery file,
// and the nvim runtime that `nvimPaths.ts` builds under userData. The real
// ~/.config/grove is never opened, so an instance the user is running keeps
// its sessions and its editor state while this one runs beside it.
//
// The profile is seeded to open the generated demo repository on launch, with
// the intro and setup stages already marked done — a test should start in the
// workspace, not on a wizard.
//
//   bun scripts/test-env.ts dev       prepare, then launch the app
//   bun scripts/test-env.ts prepare   build the profile and the demo repo
//   bun scripts/test-env.ts debug …   run grove-debug against this instance
//   bun scripts/test-env.ts env       print the environment, for eval/export
//   bun scripts/test-env.ts reset     delete the profile and the demo repo

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_PERMISSIONS } from '../sdk/src/protocol'
import {
  DEMO_BRANCH,
  createDemoRepo,
  demoWorktreePathFor,
  type DemoRepo
} from '../tests/e2e/fixtures/demoRepo'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Gitignored, and deliberately inside the repo so a relaunch keeps its state. */
const TEST_ROOT = join(repoRoot, '.grove-test')

export interface TestEnvironment {
  /** What grove writes its profile into. */
  configHome: string
  /** Electron's userData for that profile. */
  userData: string
  /** The demo repository grove opens. */
  demoRepo: string
  /** The variables to launch or drive the app with. */
  env: Record<string, string>
}

export function testEnvironment(root = TEST_ROOT): TestEnvironment {
  const configHome = join(root, 'config')
  return {
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

/** Build the profile and the demo repo, leaving the app ready to launch. */
async function prepare(): Promise<TestEnvironment> {
  const environment = testEnvironment()
  for (const directory of Object.values(environment.env)) {
    if (directory.startsWith(TEST_ROOT)) await mkdir(directory, { recursive: true })
  }
  await mkdir(environment.userData, { recursive: true })

  // Reused when it is already there: `prepare` runs on every launch, and
  // rebuilding the repo under an app that has it open loses whatever the last
  // session was looking at. `reset` is how you ask for a clean one.
  const demo = await reuseOrCreateDemoRepo(environment.demoRepo)
  // grove stores the repo root as git reports it; a symlinked path would not
  // match the key it later looks its own state up under.
  const canonicalRoot = await realpath(demo.root)
  await seedWorkbenchState(environment.userData, canonicalRoot)
  await prePair(environment, DEBUG_APP_ID)

  console.log(`profile:   ${environment.userData}`)
  console.log(`demo repo: ${canonicalRoot}`)
  console.log(`worktree:  ${demo.worktreePath} (${demo.branch})`)
  return environment
}

/**
 * Point the profile at the demo repo, so grove opens it on launch.
 *
 * Only `lastRepoPath` is written. The per-repo entry is left for grove to
 * create through its own `emptyRepoState()`: that record has a dozen fields
 * which are read without a default, so a partial one seeded from here would
 * crash the open and would drift the moment a field is added. Whatever is
 * already on disk is kept, so a relaunch resumes the previous layout.
 *
 * The intro page stays away because the demo repo has an AGENTS.md, which is
 * what grove reads as "this repo is already set up".
 */
async function seedWorkbenchState(userData: string, repoPath: string): Promise<void> {
  const statePath = join(userData, 'workbench-state.json')
  const state = await readJson(statePath)
  state.lastRepoPath = repoPath
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
}

/** The app id `scripts/grove-debug.ts` connects under. */
const DEBUG_APP_ID = 'grove-debug'

/** The demo repo as it stands, building it first if this is a cold profile. */
async function reuseOrCreateDemoRepo(root: string): Promise<DemoRepo> {
  if (await isGitRepo(root)) {
    return { root, worktreePath: demoWorktreePathFor(root), branch: DEMO_BRANCH }
  }
  return createDemoRepo(root)
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await stat(join(root, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Grant an app id its pairing token up front, so connecting never raises the
 * approval dialog.
 *
 * Pairing is a real trust boundary and is meant to be interactive — but this
 * profile is a scratch one that only ever holds the demo repo, and a test run
 * cannot click the dialog. Both sides of the handshake are written here: the
 * sha256 of the token into grove's own store, and the token itself into the
 * client token store that the SDK reads (keyed off XDG_CONFIG_HOME, which this
 * profile already redirects).
 *
 * Every scope is granted, because asking for one that was not would put the
 * dialog back as a scope escalation.
 */
async function prePair(environment: TestEnvironment, appId: string): Promise<void> {
  const token = randomBytes(32).toString('hex')
  const now = new Date().toISOString()

  const storePath = join(environment.userData, 'external-apps.json')
  const store = await readJson(storePath)
  const apps = (store.apps as Record<string, unknown>) ?? {}
  store.apps = {
    ...apps,
    [appId]: {
      appId,
      name: 'Grove Test Environment',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      grantedScopes: PLUGIN_PERMISSIONS,
      createdAt: now,
      lastSeenAt: now
    }
  }
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8')

  const tokenPath = join(environment.configHome, 'grove', 'tokens', appId)
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 })
  await writeFile(tokenPath, token, { encoding: 'utf8', mode: 0o600 })
  await chmod(tokenPath, 0o600)

  await grantEveryCapability(environment, `app:${appId}`)
}

/**
 * Pre-answer the permission broker for a paired client.
 *
 * Pairing only establishes who the client is; each capability it then reaches
 * for raises its own allow/deny dialog. Recording every scope as granted is
 * what turns the second gate off — without it the first `debug.nvim.lua` call
 * sits on a dialog nobody is there to click.
 */
async function grantEveryCapability(
  environment: TestEnvironment,
  clientKey: string
): Promise<void> {
  const grantsPath = join(environment.userData, 'plugin-grants.json')
  const store = await readJson(grantsPath)
  const clients = (store.plugins as Record<string, unknown>) ?? {}

  const permissions: Record<string, 'granted'> = {}
  for (const permission of PLUGIN_PERMISSIONS) permissions[permission] = 'granted'

  store.plugins = {
    ...clients,
    [clientKey]: { permissions, fsScopes: [environment.demoRepo] }
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

/** Launch the app against the profile. Inherits stdio, so logs land in the caller. */
async function dev(): Promise<number> {
  const environment = await prepare()
  console.log('\nlaunching `bun run dev` against the test profile…\n')
  return runToCompletion('bun', ['run', 'dev'], environment)
}

/** Run the debug harness against this instance rather than the user's own. */
async function debug(args: string[]): Promise<number> {
  const environment = testEnvironment()
  return runToCompletion('bun', ['scripts/grove-debug.ts', ...args], environment)
}

function runToCompletion(
  command: string,
  args: string[],
  environment: TestEnvironment
): Promise<number> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...environment.env }
  })
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
}

async function reset(): Promise<void> {
  // The linked worktree is created beside the repo, so remove it before the
  // tree that contains both.
  await rm(demoWorktreePathFor(testEnvironment().demoRepo), { recursive: true, force: true })
  await rm(TEST_ROOT, { recursive: true, force: true })
  console.log(`removed ${TEST_ROOT}`)
}

function printEnvironment(): void {
  const environment = testEnvironment()
  for (const [key, value] of Object.entries(environment.env)) {
    console.log(`${key}=${value}`)
  }
}

const [command = 'prepare', ...rest] = process.argv.slice(2)

if (command === 'dev') process.exit(await dev())
else if (command === 'debug') process.exit(await debug(rest))
else if (command === 'reset') await reset()
else if (command === 'env') printEnvironment()
else if (command === 'prepare') await prepare()
else {
  console.error(`unknown command: ${command}`)
  console.error('expected one of: dev, prepare, debug, env, reset')
  process.exit(1)
}
