// The Playwright fixture: one Electron app, on a profile of its own.
//
// Each test gets a fresh profile in a temp directory and a fresh demo repo, so
// nothing carries between tests and nothing touches the user's ~/.config/grove.
// The window is handed over once grove has finished opening the repo, because
// almost everything worth asserting on needs a worktree to exist first.

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  expect,
  test as base,
  _electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type {
  AgentMode,
  BlobDescriptor,
  ClientEventBody,
  CreateSessionOptions,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate
} from '../../../src/shared/agents'
import type { DemoRepo } from './demoRepo'
import { prepareProfile, profileAt, type GroveProfile } from './profile'

const execFileAsync = promisify(execFile)

// Playwright transpiles to CommonJS and runs from the repo root; see build.ts.
const repoRoot = process.cwd()

export interface GroveApp {
  electron: ElectronApplication
  page: Page
  profile: GroveProfile
  demo: DemoRepo
}

export const test = base.extend<{ grove: GroveApp }>({
  grove: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'grove-e2e-'))
    const profile = profileAt(root)
    const demo = await prepareProfile(profile)

    const electron = await _electron.launch({
      // The repo root, not `out/main/index.js` directly. Electron takes the app
      // name from the package.json beside the entry point it is given, and
      // there is none in `out/main` — the name falls back to "Electron", which
      // moves userData to $XDG_CONFIG_HOME/Electron and hands the app an empty
      // profile that has never heard of the demo repo. Pointing at the root
      // picks up `name: "grove"` and its `main` field, which is that same file.
      args: [repoRoot],
      cwd: repoRoot,
      env: { ...process.env, ...profile.env } as Record<string, string>
    })
    const page = await electron.firstWindow()
    await waitForWorktree(page)
    await dismissSetup(page)

    try {
      await use({ electron, page, profile, demo })
    } finally {
      await shutDown(electron, page)
      await killStragglers(profile)
      await rm(root, { recursive: true, force: true })
      await rm(`${profile.demoRepo}-worktree`, { recursive: true, force: true })
    }
  }
})

/**
 * Close the app, and kill it if it will not go.
 *
 * grove's own shutdown stops nvim, the LSP servers, the agent runs and the API
 * socket, and it does not always finish promptly. A teardown that waits for it
 * turns one slow quit into a worker-teardown timeout, which Playwright reports
 * against the whole file rather than the test that caused it.
 */
async function shutDown(electron: ElectronApplication, page: Page): Promise<void> {
  const app = electron.process()

  // Closing the window is grove's own way out: `window-all-closed` quits the
  // app. `electron.close()` is deliberately not used — it adds ten seconds per
  // test and changes nothing, because Playwright's worker teardown waits on
  // grove either way (see the known issue in the e2e README).
  await page.close().catch(() => {})
  if (await Promise.race([exited(app), after(5_000)])) return

  app.kill('SIGTERM')
  if (!(await Promise.race([exited(app), after(5_000)]))) {
    app.kill('SIGKILL')
    await Promise.race([exited(app), after(5_000)])
  }
}

/**
 * Kill the helper processes the main one leaves behind.
 *
 * Electron's renderer and network-service helpers do not die with their parent:
 * they are reparented to init and keep the stdio pipes they inherited from the
 * test worker, which then cannot exit — the run reports every test as passed
 * and the worker teardown as timed out.
 *
 * Matching on the profile path is what makes this safe. It is a unique temp
 * directory per test, so this cannot reach an instance the user is running.
 */
async function killStragglers(profile: GroveProfile): Promise<void> {
  await execFileAsync('pkill', ['-9', '-f', `user-data-dir=${profile.userData}`]).catch(() => {
    // pkill exits non-zero when nothing matched, which is the good case.
  })
}

function after(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms))
}

function exited(app: ReturnType<ElectronApplication['process']>): Promise<true> {
  if (app.exitCode !== null || app.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => app.once('exit', () => resolve(true)))
}

/**
 * Wait until grove has the demo repo open.
 *
 * The window exists well before the repo does — opening it is git work the main
 * process does after the renderer has painted — so a test that starts at
 * `firstWindow` races the thing it is about to assert on.
 */
async function waitForWorktree(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as unknown as GroveWindow).__grove_debug?.store?.selectedWorktree?.path),
    undefined,
    { timeout: 60_000 }
  )
}

/**
 * Get the first-run setup wizard out of the way.
 *
 * It covers the whole centre pane, so anything behind it is unreachable. The
 * repo state it would be dismissed in is created by grove on open and has a
 * dozen fields read without a default, so clicking is more robust than seeding
 * a partial record into workbench-state.json.
 */
async function dismissSetup(page: Page): Promise<void> {
  const notNow = page.getByRole('button', { name: 'Not now' })
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
}

/**
 * Start an agent session through the pane, and hand back its id.
 *
 * The agent pane is on screen when grove opens, so this is the button a user
 * presses. Shared because more than one spec needs a session to exist before it
 * has anything to assert on.
 */
export async function startAgentSession(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByTestId('agent-mode-trigger')).toBeVisible()

  return page.evaluate(async () => {
    const view = window as unknown as GroveWindow
    const sessions = await view.workbench.agents.listSessions()
    return sessions[sessions.length - 1].id
  })
}

/**
 * The window as a test sees it.
 *
 * Only the surface these tests drive is declared. The preload's own global
 * types are not in scope here — they are declared for the renderer build — and
 * spelling out what is used keeps a test honest about what it depends on.
 */
export interface GroveWindow {
  __grove_debug?: {
    store?: { selectedWorktree?: { id: string; path: string } }
    layout?: { ensurePane(paneTypeId: string): void }
    agentSessions?: {
      modeFor(sessionId: string): AgentMode
      open?(sessionId: string): Promise<void>
      close?(sessionId: string): void
      refreshList?(): Promise<void>
    }
  }
  workbench: {
    agents: {
      createSession(options: CreateSessionOptions): Promise<SessionSnapshot>
      getSession(sessionId: string): Promise<SessionSnapshot>
      listSessions(): Promise<SessionMeta[]>
      updateSession(
        sessionId: string,
        changes: SessionUpdate
      ): Promise<{ changed: string[]; session: SessionSnapshot }>
      deleteSession(sessionId: string): Promise<void>
      listEvents(sessionId: string, after?: number): Promise<SessionEvent[]>
      sendEvents(sessionId: string, events: ClientEventBody[]): Promise<{ lastSeq: number }>
      uploadBlob(
        sessionId: string,
        bytes: Uint8Array,
        mediaType: string,
        filename?: string
      ): Promise<BlobDescriptor>
    }
  }
}

export { expect } from '@playwright/test'
export type { Page } from '@playwright/test'
