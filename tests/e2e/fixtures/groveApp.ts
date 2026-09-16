// The Playwright fixture: one Electron app, on a profile of its own.
//
// Each test gets a fresh profile in a temp directory and a fresh demo repo, so
// nothing carries between tests and nothing touches the user's ~/.config/grove.
// The window is handed over once grove has finished opening the repo, because
// almost everything worth asserting on needs a worktree to exist first.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test'
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
      args: [join(repoRoot, 'out', 'main', 'index.js')],
      cwd: repoRoot,
      env: { ...process.env, ...profile.env } as Record<string, string>
    })
    const page = await electron.firstWindow()
    await waitForWorktree(page)

    try {
      await use({ electron, page, profile, demo })
    } finally {
      await electron.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
      await rm(`${profile.demoRepo}-worktree`, { recursive: true, force: true })
    }
  }
})

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
