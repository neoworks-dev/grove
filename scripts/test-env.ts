// Launch grove into an isolated profile, for driving it without touching the
// user's own instance.
//
// The profile itself is `tests/e2e/fixtures/profile.ts` — the same one the
// Playwright suite makes per run. This keeps one around under `.grove-test/`
// so a relaunch resumes where the last session left off.
//
//   bun scripts/test-env.ts dev       prepare, then launch the app
//   bun scripts/test-env.ts built     launch out/ the way the e2e fixture does
//   bun scripts/test-env.ts prepare   build the profile and the demo repo
//   bun scripts/test-env.ts debug …   run grove-debug against this instance
//   bun scripts/test-env.ts env       print the environment, for eval/export
//   bun scripts/test-env.ts reset     delete the profile and the demo repo

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoWorktreePathFor } from '../tests/e2e/fixtures/demoRepo'
import { prepareProfile, profileAt, type GroveProfile } from '../tests/e2e/fixtures/profile'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Gitignored, and deliberately inside the repo so a relaunch keeps its state. */
const TEST_ROOT = join(repoRoot, '.grove-test')

function environment(): GroveProfile {
  return profileAt(TEST_ROOT)
}

async function prepare(): Promise<GroveProfile> {
  const profile = environment()
  const demo = await prepareProfile(profile)

  console.log(`profile:   ${profile.userData}`)
  console.log(`demo repo: ${demo.root}`)
  console.log(`worktree:  ${demo.worktreePath} (${demo.branch})`)
  return profile
}

/** Launch the app against the profile. Inherits stdio, so logs land in the caller. */
async function dev(): Promise<number> {
  const profile = await prepare()
  console.log('\nlaunching `bun run dev` against the test profile…\n')
  return runToCompletion('bun', ['run', 'dev'], profile)
}

/**
 * Launch the built app, the way the Playwright fixture does.
 *
 * The e2e suite runs `out/` rather than the dev server, and the two do not fail
 * the same way — this is how to watch a launch the suite only reports as a
 * timeout. Electron is given the repo root, not `out/main/index.js`: it takes
 * the app name from the package.json beside the entry point it is handed, and
 * `out/main` has none, which silently moves the whole profile to
 * $XDG_CONFIG_HOME/Electron.
 *
 * Pass `--fresh` for a cold profile in a temp directory, which is what each
 * test gets; without it the usual `.grove-test` one is reused.
 */
async function built(args: string[]): Promise<number> {
  const fresh = args.includes('--fresh')
  const root = fresh ? await mkdtemp(join(tmpdir(), 'grove-e2e-')) : TEST_ROOT
  const profile = profileAt(root)
  const demo = await prepareProfile(profile)

  console.log(`profile:   ${profile.userData}`)
  console.log(`demo repo: ${demo.root}\n`)
  return runToCompletion(electronBinary(), ['.'], profile)
}

function electronBinary(): string {
  return join(repoRoot, 'node_modules', '.bin', 'electron')
}

/** Run the debug harness against this instance rather than the user's own. */
function debug(args: string[]): Promise<number> {
  return runToCompletion('bun', ['scripts/grove-debug.ts', ...args], environment())
}

function runToCompletion(command: string, args: string[], profile: GroveProfile): Promise<number> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...profile.env }
  })
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
}

async function reset(): Promise<void> {
  // The linked worktree is created beside the repo, so remove it before the
  // tree that contains both.
  await rm(demoWorktreePathFor(environment().demoRepo), { recursive: true, force: true })
  await rm(TEST_ROOT, { recursive: true, force: true })
  console.log(`removed ${TEST_ROOT}`)
}

function printEnvironment(): void {
  for (const [key, value] of Object.entries(environment().env)) {
    console.log(`${key}=${value}`)
  }
}

const [command = 'prepare', ...rest] = process.argv.slice(2)

if (command === 'dev') process.exit(await dev())
else if (command === 'built') process.exit(await built(rest))
else if (command === 'debug') process.exit(await debug(rest))
else if (command === 'reset') await reset()
else if (command === 'env') printEnvironment()
else if (command === 'prepare') await prepare()
else {
  console.error(`unknown command: ${command}`)
  console.error('expected one of: dev, built, prepare, debug, env, reset')
  process.exit(1)
}
