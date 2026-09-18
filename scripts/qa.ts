#!/usr/bin/env bun
// The QA harness: a running grove, and a command surface for using it the way a
// person does.
//
// End-to-end specs assert on what can be asserted on. This is for everything
// else — whether a pane feels right when it is dragged, whether the GitHub view
// is usable, whether vim behaves under a real keyboard — and it exists so that
// job can be handed to a model instead of a person. `qa explore` starts one.
//
//   bun run qa start                     launch a session on a display of its own
//   bun run qa shot opened-explorer      a screenshot, to look at
//   bun run qa probe                     what is on screen, and refs to act on it by
//   bun run qa click "New session"       act
//   bun run qa stop
//
// The app itself is driven from `scripts/qa/drive.ts`, which runs under node.
// Everything here is bun, and shells out to it.
//
// Targets ("New session", `e12`, `at=820,460`) are `scripts/qa/targets.ts`.

import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoWorktreePathFor } from '../tests/e2e/fixtures/demoRepo'
import { prepareProfile, profileAt, type GroveProfile } from '../tests/e2e/fixtures/profile'
import { displayEnv, startVirtualDisplay, stopVirtualDisplay } from './lib/virtualDisplay'
import { renderTranscript } from './qa/transcript'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The profile the session runs on — the same one `scripts/test-env.ts` uses. */
const TEST_ROOT = join(repoRoot, '.grove-test')

/** What a run leaves behind: screenshots, refs, logs, reports. Gitignored. */
const QA_ROOT = join(repoRoot, '.grove-qa')

/**
 * The remote the demo repo is given, so the GitHub surfaces have something real.
 *
 * A scratch repository, and the QA agent is expected to write to it: the issues,
 * branches and pull requests in there were made by a test run.
 */
const SANDBOX_REMOTE = 'https://github.com/neoworks-dev/grove-qa-sandbox.git'

interface Session {
  display: string
  displayPid: number
  appPid: number
  port: number
  startedAt: string
}

const paths = {
  session: join(QA_ROOT, 'session.json'),
  refs: join(QA_ROOT, 'refs.json'),
  shots: join(QA_ROOT, 'shots'),
  reports: join(QA_ROOT, 'reports'),
  appLog: join(QA_ROOT, 'app.log')
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help') {
    usage()
    return
  }

  if (command === 'start') return start(args)
  if (command === 'stop') return stop()
  if (command === 'status') return status()
  if (command === 'explore') return explore(args)
  if (command === 'finding') return fileFinding(args)
  if (command === 'charters') return listCharters()
  if (command === 'log') return showLog(args)
  if (command === 'nvim') return nvim(args)
  return act(command, args)
}

// ------------------------------------------------------------------ sessions

/**
 * Bring up a session: a display, the built app on the test profile, a CDP port.
 *
 * The built app rather than the dev server, because that is what ships and the
 * two do not fail the same way. `--build` rebuilds first; without it the last
 * build is reused, and a missing one is an error rather than a twenty-minute
 * surprise.
 */
async function start(args: string[]): Promise<void> {
  if (readSession()) {
    console.log('a session is already running — "qa stop" first, or "qa status" to see it')
    return
  }
  if (args.includes('--fresh')) await resetProfile()
  if (args.includes('--build')) build()
  requireBuild()

  mkdirSync(paths.shots, { recursive: true })
  mkdirSync(paths.reports, { recursive: true })

  const profile = profileAt(TEST_ROOT)
  const demo = await prepareProfile(profile)
  wireSandboxRemote(demo.root)

  const virtual = await startVirtualDisplay({ detached: true })
  if (!virtual) {
    throw new Error(
      'no Xvfb or Xvnc available, and every display from :90 to :99 is taken.\n' +
        'install one (sudo pacman -S xorg-server-xvfb) or free a display.'
    )
  }

  const port = await freePort()
  const appPid = launchApp(profile, virtual.display, port)
  const session: Session = {
    display: virtual.display,
    displayPid: virtual.pid,
    appPid,
    port,
    startedAt: new Date().toISOString()
  }
  writeFileSync(paths.session, JSON.stringify(session, null, 2), 'utf8')

  await waitForDebugPort(port)
  const ready = drive(session, { action: 'ready', timeout: 90_000 })

  console.log(`display:   ${virtual.display}  (watch it: vncviewer ${virtual.display})`)
  console.log(`profile:   ${profile.userData}`)
  console.log(`demo repo: ${demo.root}  →  ${SANDBOX_REMOTE}`)
  console.log(`app log:   ${paths.appLog}`)
  console.log(ready)
}

/** Take the session down: the app, everything it spawned, and the display. */
async function stop(): Promise<void> {
  const session = readSession()
  const profile = profileAt(TEST_ROOT)

  const killed = killProfileProcesses(profile)
  if (session) stopVirtualDisplay(session.display, session.displayPid)
  await rm(paths.session, { force: true })

  console.log(`stopped ${killed} of the test profile's processes`)
}

function status(): void {
  const session = readSession()
  if (!session) {
    console.log('no session — "qa start"')
    return
  }
  console.log(JSON.stringify(session, null, 2))
  console.log(drive(session, { action: 'state' }))
}

function readSession(): Session | null {
  try {
    const session: Session = JSON.parse(readFileSync(paths.session, 'utf8'))
    // A session file outliving its app is the common case: the machine slept,
    // the app crashed, someone killed it. Report it as gone rather than time out
    // against a port nothing is listening on.
    if (!isRunning(session.appPid)) return null
    return session
  } catch {
    return null
  }
}

function requireSession(): Session {
  const session = readSession()
  if (!session) throw new Error('no session is running — "qa start" first')
  return session
}

// ------------------------------------------------------------------ actions

/** Everything that acts on the running app, forwarded to the node driver. */
function act(command: string, args: string[]): void {
  const session = requireSession()
  // `--shot label` on any action: take the screenshot in the same connection
  // the action ran in, so what it shows is what the action left behind.
  const shotLabel = optional(args, '--shot')
  let shot: string | undefined = undefined
  if (shotLabel !== undefined) shot = nextShotPath(shotLabel)

  console.log(drive(session, { ...actionFor(command, args), shot }))
}

/** The flags that are followed by a value, as opposed to standing alone. */
const VALUE_FLAGS = ['--shot', '--of', '--at', '--model', '--title', '--body', '--label', '--repo']

/** What is left once the flags and their values are taken out. */
function positional(args: string[]): string[] {
  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (VALUE_FLAGS.includes(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('--')) continue
    rest.push(argument)
  }
  return rest
}

/** The command the driver runs, built from what was typed. */
function actionFor(command: string, args: string[]): Record<string, unknown> {
  const rest = positional(args)

  if (command === 'shot') {
    return { action: 'shot', path: nextShotPath(rest[0]), target: optional(args, '--of') }
  }
  if (command === 'probe') {
    return { action: 'probe', filter: rest[0] }
  }
  if (command === 'click' || command === 'dblclick' || command === 'rightclick') {
    requireArgument(rest[0], `${command} <target>`)
    let count = 1
    if (command === 'dblclick') count = 2
    let button = 'left'
    if (command === 'rightclick') button = 'right'
    return { action: 'click', target: rest[0], count, button }
  }
  if (command === 'drag') {
    requireArgument(rest[1], 'drag <from> <to>')
    return { action: 'drag', from: rest[0], to: rest[1] }
  }
  if (command === 'type') {
    requireArgument(rest[0], 'type <text>')
    return { action: 'type', text: rest[0] }
  }
  if (command === 'key') {
    requireArgument(rest[0], 'key <chord> [chord …]')
    return { action: 'key', keys: rest }
  }
  if (command === 'scroll') {
    requireArgument(rest[0], 'scroll <dy> [--at <target>]')
    return { action: 'scroll', dy: Number(rest[0]), target: optional(args, '--at') }
  }
  if (command === 'wait') {
    requireArgument(rest[0], 'wait <target> [--gone]')
    return { action: 'wait', target: rest[0], gone: args.includes('--gone') }
  }
  if (command === 'eval') {
    requireArgument(rest[0], 'eval <expression>')
    return { action: 'eval', expression: rest[0] }
  }
  if (command === 'console') {
    return { action: 'console' }
  }
  throw new Error(`unknown command: ${command} (try "qa help")`)
}

/**
 * Run one action in the driver.
 *
 * A process per action, because `connectOverCDP` has to run under node and
 * nothing needs to be remembered between two of them. Node's start-up is the
 * price, and it is smaller than the class of bug a long-lived driver holding a
 * stale page would buy.
 */
function drive(session: Session, command: Record<string, unknown>): string {
  const result = spawnSync(
    'node',
    [join(repoRoot, 'scripts', 'qa', 'drive.ts'), String(session.port), paths.refs, JSON.stringify(command)],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  if (result.status !== 0) {
    throw new Error(`${command.action} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout.trim()
}

/** Screenshots are numbered, so a run reads back in the order it happened. */
function nextShotPath(label: string | undefined): string {
  mkdirSync(paths.shots, { recursive: true })
  const taken = readdirSync(paths.shots).filter((name) => name.endsWith('.png')).length
  const number = String(taken + 1).padStart(3, '0')
  const slug = (label ?? 'shot').replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()
  return join(paths.shots, `${number}-${slug}.png`)
}

/** The editor, through the debug harness the rest of the repo already uses. */
function nvim(args: string[]): void {
  requireArgument(args[0], 'nvim <lua>')
  requireSession()
  const result = spawnSync('bun', ['scripts/test-env.ts', 'debug', 'lua', args[0]], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  console.log((result.stdout || result.stderr).trim())
}

function showLog(args: string[]): void {
  const lines = Number(args[0] ?? 40)
  const contents = readFileSync(paths.appLog, 'utf8').split('\n')
  console.log(contents.slice(-lines).join('\n'))
}

// ------------------------------------------------------------------ the app

function launchApp(profile: GroveProfile, display: string, port: number): number {
  const log = openSync(paths.appLog, 'a')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...profile.env,
    ...displayEnv(display)
  }
  delete env.WAYLAND_DISPLAY

  // The profile redirects XDG_CONFIG_HOME, which is where `gh` keeps its login —
  // without this the GitHub surfaces are all "not authenticated" and there is
  // nothing to test. This does mean the session can reach the user's account,
  // which is why the demo repo's remote is a sandbox.
  const ghConfig = join(homedir(), '.config', 'gh')
  if (existsSync(ghConfig)) env.GH_CONFIG_DIR = ghConfig

  const child = spawn(
    join(repoRoot, 'node_modules', '.bin', 'electron'),
    [
      // The repo root, not out/main/index.js: electron takes the app name from
      // the package.json beside the entry point it is handed, and out/main has
      // none — the profile would silently move to $XDG_CONFIG_HOME/Electron.
      '.',
      `--remote-debugging-port=${port}`,
      // Chromium refuses a devtools websocket from an unlisted origin, and
      // Playwright's CDP connection sends one.
      '--remote-allow-origins=*',
      // The virtual display has no pointer device, so Chromium reports
      // `hover: none` and every Tailwind `hover:` rule is dead — a tab's close
      // button stays zero-width and unclickable. Declare the mouse a user has.
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'
    ],
    { cwd: repoRoot, env, detached: true, stdio: ['ignore', log, log] }
  )
  child.unref()
  if (child.pid === undefined) throw new Error(`electron did not start — see ${paths.appLog}`)
  return child.pid
}

async function waitForDebugPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`the app never opened its debug port — see ${paths.appLog}`)
}

function build(): void {
  console.log('building…')
  const result = spawnSync('bun', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('build failed')
}

function requireBuild(): void {
  if (existsSync(join(repoRoot, 'out', 'main', 'index.js'))) return
  throw new Error('no build to launch — "qa start --build", or "bun run build"')
}

/**
 * Give the demo repo the sandbox as its origin, and put its history there.
 *
 * Without a remote the GitHub views have nothing to show and nothing to do:
 * no pull requests, no issues, no branch to open one from.
 */
function wireSandboxRemote(demoRoot: string): void {
  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', ['-C', demoRoot, ...args], { encoding: 'utf8' })

  const existing = git('remote', 'get-url', 'origin')
  if (existing.status === 0) {
    if (existing.stdout.trim() === SANDBOX_REMOTE) return
    git('remote', 'set-url', 'origin', SANDBOX_REMOTE)
  } else {
    git('remote', 'add', 'origin', SANDBOX_REMOTE)
  }

  const pushed = git('push', '--force', '-u', 'origin', 'main')
  if (pushed.status !== 0) {
    console.warn(`could not push the demo repo to the sandbox:\n${pushed.stderr.trim()}`)
  }
}

async function resetProfile(): Promise<void> {
  await rm(demoWorktreePathFor(profileAt(TEST_ROOT).demoRepo), { recursive: true, force: true })
  await rm(TEST_ROOT, { recursive: true, force: true })
  console.log(`removed ${TEST_ROOT}`)
}

// --------------------------------------------------------------- processes

/**
 * Kill everything running on the test profile.
 *
 * `pkill -f` cannot do this. The app's command line is `electron .`, which the
 * user's own instance also matches, and the children grove spawns — the
 * embedded neovim, the language servers — have nothing in theirs to match on at
 * all. What they do share is the environment they inherited, and the profile
 * directories in it are this repo's `.grove-test`, which no instance of the
 * user's has ever heard of.
 */
function killProfileProcesses(profile: GroveProfile): number {
  const marker = `XDG_CONFIG_HOME=${profile.configHome}`
  let killed = 0

  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    let environ = ''
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
    } catch {
      continue
    }
    if (!environ.includes(marker)) continue
    try {
      process.kill(pid, 'SIGKILL')
      killed += 1
    } catch {
      // Gone between reading /proc and signalling it.
    }
  }
  return killed
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A port nothing is listening on, for this session's devtools endpoint. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not find a free port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

// ------------------------------------------------------------------ charters

const CHARTER_DIR = join(repoRoot, '.claude', 'skills', 'grove-qa', 'charters')

/**
 * Turn a Claude Code instance loose on the app and let it report what it finds.
 *
 * Sonnet, because this is hours of clicking and looking rather than a hard
 * problem, and a process of its own rather than a subagent so it has a whole
 * context to spend. It can read the repo and drive the harness; it cannot edit
 * anything. What it produces is issues, not fixes.
 *
 *   qa explore                     the whole app
 *   qa explore "the GitHub pane"   one part of it
 *   qa explore editing             a charter that ships with the harness
 */
function explore(args: string[]): void {
  const scope = positional(args)[0]
  let model = optional(args, '--model')
  if (model === undefined) model = 'sonnet'
  const fileIssues = !args.includes('--dry-run')

  if (!readSession()) {
    throw new Error('no session is running — "qa start" first, so the agent has an app to drive')
  }

  let charter = 'Explore the whole app. Cover every surface you can reach.'
  if (scope !== undefined) charter = charterText(scope)

  const label = scope === undefined ? 'whole-app' : scope
  const report = join(paths.reports, `${stamp()}-${slug(label)}.md`)
  mkdirSync(paths.reports, { recursive: true })

  let filing = 'Do not file any issues — this is a dry run. The report is the deliverable.'
  if (fileIssues) {
    filing = `File each finding as its own GitHub issue with "bun run qa finding", which
attaches the screenshot and adds the ${AI_LABEL} label. Say what you did, what
happened, and what you expected.`
  }

  const prompt = `You are testing Grove by using it, the way a person would.

Read .claude/skills/grove-qa/SKILL.md first. It has the harness commands, how to
see what is on screen, and what is worth reporting.

A session is already running. Do not start, stop or rebuild one.

Before you touch the app, read what is already known about the part you are
testing:

    gh issue list --repo ${FINDINGS_REPO} --state open --limit 100
    gh issue view <number> --repo ${FINDINGS_REPO}

Pick out the ones in your area and read them. Two reasons. A finding that is
already filed is not a finding — say in your report that you saw it again, and
add a comment to that issue if you learned something new about it. And an open
issue is a lead: go and see whether it is still true, whether it is worse than it
says, and what is next to it that nobody has filed yet.

What to cover:

${charter}

Work in small loops: act, screenshot, look at the screenshot, decide. Note
anything that is broken, confusing, inconsistent, ugly, slow, or that made you
guess what to do — the last one matters as much as the crashes.

Keep ${report} up to date as you go, so the work survives running out of context.

${filing}

Read the code to understand what you are seeing, but do not change any of it.`

  const child = spawn(
    'claude',
    [
      '--model',
      model,
      '--allowedTools',
      // Nothing outside this list can be reached, and a run has nobody to
      // answer a permission prompt — anything missing here stops it dead rather
      // than asking. `Edit` is on it because the report is kept up to date as
      // the run goes, which is an edit after the first write.
      [
        'Read',
        'Glob',
        'Grep',
        'Write',
        'Edit',
        'Bash(bun run qa:*)',
        'Bash(gh issue:*)',
        'Bash(gh label:*)'
      ].join(','),
      // Exploring is long, and the context fills with screenshots and probe
      // dumps. Without this the run stops when it is full, halfway through a
      // charter; with it, it compacts and carries on.
      '--autocompact',
      '200000',
      // Rendered by `qa/transcript.ts` rather than printed: the run is mostly
      // looking at screenshots, and those are worth drawing where they happened.
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '-p',
      prompt
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] }
  )

  let opening = 'exploring the whole app'
  if (scope !== undefined) opening = `exploring: ${label}`
  console.log(`${opening}\n`)
  void renderTranscript(child.stdout)

  // Ctrl-C reaches the agent too — it shares this process group — so the run
  // ends either way. Say where the half-finished report is before going.
  process.on('SIGINT', () => {
    console.log(`\ninterrupted. report so far: ${report}`)
    console.log('the session is still up; "bun run qa stop" ends it')
    process.exit(130)
  })

  child.on('exit', (code) => {
    console.log(`\nreport: ${report}`)
    process.exit(code === null ? 0 : code)
  })
}

// ------------------------------------------------------------------ findings

/** Where findings are filed, and the label that says a model found them. */
const FINDINGS_REPO = 'neoworks-dev/grove'
const AI_LABEL = 'ai-found'

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
 * File one finding, with its screenshot.
 *
 *   qa finding --title "The tab strip loses the active tab on a split"
 *              --body report.md --label bug --label area:panes
 *              --shot .grove-qa/shots/012-split.png
 *
 * `--body` takes a file when it names one, and the text itself otherwise.
 */
function fileFinding(args: string[]): void {
  const title = optional(args, '--title')
  requireArgument(title, 'finding --title <title> --body <file|text> [--label …] [--shot …]')
  const body = optional(args, '--body')
  requireArgument(body, 'finding --title <title> --body <file|text> [--label …] [--shot …]')

  ensureLabel()
  const images = all(args, '--shot').map(uploadScreenshot)
  const labels = [AI_LABEL, ...all(args, '--label')]

  const sections = [bodyText(body as string)]
  if (images.length > 0) {
    sections.push(images.map((url) => `![screenshot](${url})`).join('\n\n'))
  }
  sections.push(`---\n\n*Found by an exploratory QA agent on ${headCommit()}.*`)

  const created = spawnSync(
    'gh',
    [
      'issue',
      'create',
      '--repo',
      FINDINGS_REPO,
      '--title',
      title as string,
      '--body',
      sections.join('\n\n'),
      ...labels.flatMap((name) => ['--label', name])
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (created.status !== 0) throw new Error(`could not file the issue:\n${created.stderr.trim()}`)
  console.log(created.stdout.trim())
}

/** Put a screenshot somewhere GitHub will render it from, and say where. */
function uploadScreenshot(path: string): string {
  if (!existsSync(path)) throw new Error(`no such screenshot: ${path}`)
  ensureShotBranch()

  // Committed under a timestamp, because a screenshot is evidence: two runs
  // finding the same thing must not overwrite each other's.
  const name = `${stamp()}-${slug(basename(path, '.png'))}.png`
  const committed = spawnSync(
    'gh',
    [
      'api',
      '--method',
      'PUT',
      `repos/${FINDINGS_REPO}/contents/shots/${name}`,
      '-f',
      `message=qa: screenshot for a finding`,
      '-f',
      `branch=${SHOT_BRANCH}`,
      '-f',
      `content=${readFileSync(path).toString('base64')}`
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (committed.status !== 0) {
    throw new Error(`could not upload ${path}:\n${committed.stderr.trim()}`)
  }
  return `https://raw.githubusercontent.com/${FINDINGS_REPO}/${SHOT_BRANCH}/shots/${name}`
}

function ensureShotBranch(): void {
  const found = spawnSync('gh', ['api', `repos/${FINDINGS_REPO}/git/ref/heads/${SHOT_BRANCH}`], {
    encoding: 'utf8'
  })
  if (found.status === 0) return

  const main = spawnSync(
    'gh',
    ['api', `repos/${FINDINGS_REPO}/git/ref/heads/main`, '--jq', '.object.sha'],
    { encoding: 'utf8' }
  )
  if (main.status !== 0) throw new Error(`could not read main:\n${main.stderr.trim()}`)

  const created = spawnSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${FINDINGS_REPO}/git/refs`,
      '-f',
      `ref=refs/heads/${SHOT_BRANCH}`,
      '-f',
      `sha=${main.stdout.trim()}`
    ],
    { encoding: 'utf8' }
  )
  if (created.status !== 0) {
    throw new Error(`could not create the screenshot branch:\n${created.stderr.trim()}`)
  }
}

function ensureLabel(): void {
  const found = spawnSync('gh', ['label', 'list', '--repo', FINDINGS_REPO, '--search', AI_LABEL], {
    encoding: 'utf8'
  })
  if (found.status === 0 && found.stdout.includes(AI_LABEL)) return

  spawnSync('gh', [
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
function bodyText(value: string): string {
  if (existsSync(value)) return readFileSync(value, 'utf8')
  return value
}

function headCommit(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  if (result.status !== 0) return 'an unknown build'
  return result.stdout.trim()
}

/** A charter by name from the skill's directory, or the text itself. */
function charterText(name: string): string {
  const path = join(CHARTER_DIR, `${name}.md`)
  if (existsSync(path)) return readFileSync(path, 'utf8')
  return name
}

function listCharters(): void {
  if (!existsSync(CHARTER_DIR)) {
    console.log('no charters')
    return
  }
  for (const entry of readdirSync(CHARTER_DIR)) {
    if (!entry.endsWith('.md')) continue
    const name = entry.replace(/\.md$/, '')
    const firstLine = readFileSync(join(CHARTER_DIR, entry), 'utf8').split('\n')[0]
    console.log(`${name.padEnd(12)} ${firstLine.replace(/^#\s*/, '')}`)
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase().slice(0, 40)
}

// --------------------------------------------------------------------- misc

/** The value after a flag, when it was given. */
function optional(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

/** Every value given for a flag that may be repeated, like `--label`. */
function all(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue
    const value = args[index + 1]
    if (value !== undefined) values.push(value)
  }
  return values
}

function requireArgument(value: string | undefined, form: string): void {
  if (value === undefined || value.length === 0) throw new Error(`usage: qa ${form}`)
}

function usage(): void {
  console.log(`qa — drive grove the way a person does (bun run qa <command>)

  start [--fresh] [--build]   launch a session on a display of its own
  stop                        kill the app, its children, and the display
  status                      the session, and what the renderer thinks is on screen

  shot [label] [--of <target>]   screenshot into .grove-qa/shots, and print the path
  probe [filter]                 what is on screen, with a ref for each element
  click <target>                 click it; also dblclick, rightclick
  drag <from> <to>               press, move, release — pane dividers included
  type <text>                    type into whatever has focus
  key <chord> [chord …]          Escape, Control+s, g
  scroll <dy> [--at <target>]    wheel
  wait <target> [--gone]         until it is there, or until it is not
  eval <expression>              one expression in the renderer
  console                        what the renderer has logged
  nvim <lua>                     run lua in the editor
  log [lines]                    the app's own output

Every action above takes --shot <label>, which photographs the result in the
same connection the action ran in. A menu closes when the driver disconnects, so
this is the only way to see one.

  explore [scope] [--dry-run]    hand the app to a Claude Code instance to test
  finding --title … --body …     file what it found, screenshot attached
  charters                       the charters that ship with the harness

Targets are an accessible name ("New session"), a ref from the last probe (e12),
or a point (at=820,460). role=button:Save, text=…, testid=…, css=… when a name
is ambiguous.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
