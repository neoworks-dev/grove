// What the harness writes to GitHub: findings, evidence, and the screenshots both embed.
//
// Everything goes through `gh bot` when it is installed, so it shows as
// neoworks-bot rather than as whoever ran the harness.

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** Where findings are filed, and the label that says a model found them. */
export const FINDINGS_REPO = 'neoworks-dev/grove'
export const AI_LABEL = 'ai-found'

/**
 * The branch screenshots are committed to.
 *
 * GitHub has no public API for attaching a file to an issue — the web form
 * posts to an endpoint that wants a browser session. What does work is a URL
 * the issue body embeds, and it has to be one GitHub's image proxy will fetch:
 * raw.githubusercontent serves a committed PNG as `image/png`, while a release
 * asset comes back as `application/octet-stream` and does not render at all.
 *
 * A branch of its own, so none of this lands on main.
 */
const SHOT_BRANCH = 'qa-screenshots'

/**
 * Runs gh — as neoworks-bot through the `gh bot` extension when it is installed,
 * so what the harness files and comments shows as the bot, not as whoever ran it.
 */
export function github(
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' }
): SpawnSyncReturns<string> {
  if (botAvailable()) {
    return spawnSync('gh', ['bot', ...args], options)
  }
  return spawnSync('gh', args, options)
}

let botInstalled: boolean | undefined = undefined

/** Whether the `gh bot` extension is installed; asked once per run. */
function botAvailable(): boolean {
  if (botInstalled === undefined) {
    const extensions = spawnSync('gh', ['extension', 'list'], { encoding: 'utf8' })
    botInstalled = extensions.status === 0 && /^gh bot\b/m.test(extensions.stdout)
  }
  return botInstalled
}

/** Puts a screenshot somewhere GitHub will render it from, and says where. */
export function uploadScreenshot(path: string, stamp: string): string {
  if (!existsSync(path)) {
    throw new Error(`no such screenshot: ${path}`)
  }
  ensureShotBranch()

  // Committed under a timestamp, because a screenshot is evidence: two runs
  // finding the same thing must not overwrite each other's.
  const name = `${stamp}-${slug(basename(path, '.png'))}.png`
  // The request goes in on stdin: as a `-f content=…` argument, any full-window
  // screenshot is past Linux's 128 KiB limit on a single argument.
  const request = JSON.stringify({
    message: 'qa: screenshot for a finding',
    branch: SHOT_BRANCH,
    content: readFileSync(path).toString('base64')
  })
  const committed = github(
    ['api', '--method', 'PUT', `repos/${FINDINGS_REPO}/contents/shots/${name}`, '--input', '-'],
    { encoding: 'utf8', input: request, maxBuffer: 64 * 1024 * 1024 }
  )
  if (committed.status !== 0) {
    throw new Error(`could not upload ${path}:\n${String(committed.stderr).trim()}`)
  }
  return `https://raw.githubusercontent.com/${FINDINGS_REPO}/${SHOT_BRANCH}/shots/${name}`
}

/** Creates the screenshot branch from main when it does not exist yet. */
function ensureShotBranch(): void {
  const found = github(['api', `repos/${FINDINGS_REPO}/git/ref/heads/${SHOT_BRANCH}`])
  if (found.status === 0) {
    return
  }
  const main = github(['api', `repos/${FINDINGS_REPO}/git/ref/heads/main`, '--jq', '.object.sha'])
  if (main.status !== 0) {
    throw new Error(`could not read main:\n${main.stderr.trim()}`)
  }
  const created = github([
    'api',
    '--method',
    'POST',
    `repos/${FINDINGS_REPO}/git/refs`,
    '-f',
    `ref=refs/heads/${SHOT_BRANCH}`,
    '-f',
    `sha=${main.stdout.trim()}`
  ])
  if (created.status !== 0) {
    throw new Error(`could not create the screenshot branch:\n${created.stderr.trim()}`)
  }
}

/** Creates the label findings carry when the repository does not have it yet. */
export function ensureLabel(): void {
  const found = github(['label', 'list', '--repo', FINDINGS_REPO, '--search', AI_LABEL])
  if (found.status === 0 && found.stdout.includes(AI_LABEL)) {
    return
  }
  github([
    'label',
    'create',
    AI_LABEL,
    '--repo',
    FINDINGS_REPO,
    '--color',
    '7B61FF',
    '--description',
    'Found by an exploratory QA agent driving the app'
  ])
}

/** `--body` names a file, or is the text itself. */
export function bodyText(value: string): string {
  if (existsSync(value)) {
    return readFileSync(value, 'utf8')
  }
  return value
}

/** The short hash checked out in a directory. */
export function headCommit(directory: string): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    return 'an unknown build'
  }
  return result.stdout.trim()
}

/** A value made safe and short enough for a file name. */
export function slug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase()
    .slice(0, 40)
}
