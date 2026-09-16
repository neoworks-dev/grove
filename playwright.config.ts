// End-to-end tests: the real Electron app, driven through Playwright.
//
// These are named `*.e2e.ts` rather than `*.test.ts` so `bun test` does not
// pick them up — `tests/` holds both suites, and only the unit ones belong to
// bun. Run them with `bun run test:e2e`.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.e2e\.ts/,
  globalSetup: './tests/e2e/fixtures/build.ts',
  // Each test launches its own Electron and its own profile; running several at
  // once means several nvim processes and several API sockets on one machine,
  // which makes failures about the machine rather than about grove.
  workers: 1,
  fullyParallel: false,
  // Electron start-up includes building the nvim runtime for a cold profile.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  forbidOnly: Boolean(process.env.CI),
  retries: 0
})
