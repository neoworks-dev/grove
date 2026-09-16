// The demo project the editor is opened in for end-to-end runs.
//
// Grove is a worktree editor, so a fixture that is only a folder of files
// exercises almost none of it. This builds a real git repository with the
// things the UI reads: a history to show, a dirty working tree for the git
// view, a second branch, and a linked worktree for the worktrees view.
//
// Everything is generated rather than committed. A repository inside the
// repository is awkward to work with, and a generated one is identical on
// every run — a test that starts from a known tree does not have to describe
// the state it expects to find.

import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The identity and switches every fixture commit is made under. */
const GIT_FLAGS = [
  '-c',
  'user.name=Grove E2E',
  '-c',
  'user.email=e2e@grove.invalid',
  // The machine running the tests may sign commits or run hooks by default;
  // neither belongs in a fixture, and both can prompt.
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'init.defaultBranch=main'
]

export interface DemoRepo {
  /** The main worktree, and the path grove is pointed at. */
  root: string
  /** The linked worktree, checked out on `branch`. */
  worktreePath: string
  /** The branch the linked worktree holds. */
  branch: string
}

/** The branch the linked worktree is checked out on. */
export const DEMO_BRANCH = 'feature/greeting'

/** Where `createDemoRepo` puts the linked worktree for a given root. */
export function demoWorktreePathFor(root: string): string {
  return join(dirname(root), `${basename(root)}-worktree`)
}

/**
 * Build the demo repository at `root`, replacing whatever is already there.
 *
 * The linked worktree is created beside it rather than inside it, so the
 * repository's own status stays clean of it.
 */
export async function createDemoRepo(root: string): Promise<DemoRepo> {
  const worktreePath = demoWorktreePathFor(root)
  await rm(root, { recursive: true, force: true })
  await rm(worktreePath, { recursive: true, force: true })
  await mkdir(join(root, 'src'), { recursive: true })

  await git(root, 'init')
  await writeHistory(root)
  await addBranchAndWorktree(root, worktreePath)
  await dirtyTheWorkingTree(root)

  return { root, worktreePath, branch: DEMO_BRANCH }
}

/** Three commits, so the log and the git view have something to show. */
async function writeHistory(root: string): Promise<void> {
  await write(root, 'README.md', '# Demo\n\nA fixture project for grove\'s end-to-end tests.\n')
  // Grove treats an agent-instruction file at the root as "this repo is set
  // up", which is what keeps the intro page out of the way on first open.
  await write(root, 'AGENTS.md', '# Agent notes\n\nThis is a generated fixture. Nothing here is real.\n')
  await commit(root, 'chore: initial commit')

  await write(root, 'src/index.ts', INDEX_TS)
  await commit(root, 'feat: add entry point')

  await write(root, 'src/util.ts', UTIL_TS)
  await commit(root, 'feat: add a greeting helper')
}

/** A second branch, checked out into a linked worktree. */
async function addBranchAndWorktree(root: string, worktreePath: string): Promise<void> {
  await git(root, 'branch', DEMO_BRANCH)
  await git(root, 'worktree', 'add', worktreePath, DEMO_BRANCH)
}

/**
 * One staged change and one unstaged change.
 *
 * The git view renders those two states differently, so a fixture with only
 * one of them leaves half of it untested.
 */
async function dirtyTheWorkingTree(root: string): Promise<void> {
  await write(root, 'src/util.ts', `${UTIL_TS}\nexport const STAGED = true\n`)
  await git(root, 'add', 'src/util.ts')
  await write(root, 'src/index.ts', `${INDEX_TS}\n// an unstaged edit\n`)
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', message)
}

async function git(root: string, ...args: string[]): Promise<void> {
  await run('git', [...GIT_FLAGS, '-C', root, ...args])
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? 'demo'
}

const INDEX_TS = `import { greet } from './util'

/** Entry point for the demo project. */
export function main(): void {
  console.log(greet('grove'))
}

main()
`

const UTIL_TS = `/** Build the greeting the demo prints on start-up. */
export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
`
