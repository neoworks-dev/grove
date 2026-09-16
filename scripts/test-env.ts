// Launch grove into an isolated profile, for driving it without touching the
// user's own instance.
//
// The profile itself is `tests/e2e/fixtures/profile.ts` — the same one the
// Playwright suite makes per run. This keeps one around under `.grove-test/`
// so a relaunch resumes where the last session left off.
//
//   bun scripts/test-env.ts dev       prepare, then launch the app
//   bun scripts/test-env.ts prepare   build the profile and the demo repo
//   bun scripts/test-env.ts debug …   run grove-debug against this instance
//   bun scripts/test-env.ts env       print the environment, for eval/export
//   bun scripts/test-env.ts reset     delete the profile and the demo repo

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
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
else if (command === 'debug') process.exit(await debug(rest))
else if (command === 'reset') await reset()
else if (command === 'env') printEnvironment()
else if (command === 'prepare') await prepare()
else {
  console.error(`unknown command: ${command}`)
  console.error('expected one of: dev, prepare, debug, env, reset')
  process.exit(1)
}
