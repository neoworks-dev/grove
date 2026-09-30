// What a recorded repro needs beyond the steps themselves: the checks.
//
// `qa finding` writes `tests/e2e/repro/<issue>-*.e2e.ts` from a qa session, and
// each `qa expect` in that session becomes a `verify` call here. A check that
// fails does not stop the spec — every later check still runs and still takes
// its screenshot, so one replay shows the whole state of the bug.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { CheckResult } from '../../../scripts/qa/steps'

let taken = 0

/**
 * Run one recorded check, photograph the window at that moment, and fail the
 * test (softly) when the check does.
 *
 * The screenshot is for a person to look at; the check decides. `qa replay`
 * points QA_REPLAY_SHOTS at the harness's shots directory so the pictures can go
 * straight into `qa evidence`.
 */
export async function verify(
  page: Page,
  label: string,
  check: Promise<CheckResult>
): Promise<void> {
  const result = await check
  taken += 1
  let verdict = 'fail'
  if (result.passed) verdict = 'pass'
  const name = `${String(taken).padStart(2, '0')}-${verdict}-${slug(label)}.png`
  await page.screenshot({ path: join(shotDirectory(), name) })
  console.log(
    `${verdict.toUpperCase()}  ${label}: ${result.detail}  →  ${join(shotDirectory(), name)}`
  )
  expect.soft(result.passed, `${label}: ${result.detail}`).toBe(true)
}

/** Where a check's screenshot goes: the harness's directory under `qa replay`, the test's own otherwise. */
function shotDirectory(): string {
  const fromHarness = process.env.QA_REPLAY_SHOTS
  if (fromHarness === undefined || fromHarness.length === 0) return test.info().outputDir
  mkdirSync(fromHarness, { recursive: true })
  return fromHarness
}

function slug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase()
    .slice(0, 40)
}
