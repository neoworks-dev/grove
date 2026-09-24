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
//   bun run qa probe                     the pane tree, and refs to act on it by
//   bun run qa click "New session"       act
//   bun run qa screenshot split-panes    a picture, when only a picture will do
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
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoWorktreePathFor } from '../tests/e2e/fixtures/demoRepo'
import { prepareProfile, profileAt, type GroveProfile } from '../tests/e2e/fixtures/profile'
import { displayEnv, startVirtualDisplay, stopVirtualDisplay } from './lib/virtualDisplay'
import { renderTranscript } from './qa/transcript'
import { renderPaneTypes, renderSnapshot, type PaneTypeEntry } from './qa/tree'
import { parseRegion, type Region } from './qa/targets'
import { emptyPace, noteAction, notePicture, refusePicture, type Pace } from './qa/pace'
import type { Snapshot } from './qa/snapshot'

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
  appLog: join(QA_ROOT, 'app.log'),
  pace: join(QA_ROOT, 'pace.json')
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help') {
    usage()
    return
  }

  if (command === 'start') return start(args)
  if (command === 'stop') return stop()
  if (command === 'explore') return explore(args)
  if (command === 'finding') return fileFinding(args)
  if (command === 'evidence') return postEvidence(args)
  if (command === 'charters') return listCharters()
  if (command === 'logs') return showLogs(args)
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
    console.log('a session is already running — "qa stop" first, or "qa probe" to see it')
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
  await rm(paths.pace, { force: true })

  await waitForDebugPort(port)
  const ready = drive(session, { action: 'ready', timeout: 90_000 })

  console.log(`display:   ${virtual.display}  (watch it: vncviewer ${virtual.display})`)
  console.log(`profile:   ${profile.userData}`)
  console.log(`demo repo: ${demo.root}  →  ${SANDBOX_REMOTE}`)
  console.log(`app log:   ${paths.appLog}`)
  console.log('')
  console.log(printable('probe', ready))
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
  // `--screenshot label` on any action: photograph the result in the same
  // connection the action ran in, so what it shows is what the action left
  // behind. A menu closes when the driver disconnects.
  let label = optional(args, '--screenshot')
  if (label === undefined) label = optional(args, '--shot')
  let screenshot: string | undefined = undefined
  if (label !== undefined) screenshot = nextShotPath(label)

  const crop = cropOf(args)
  const wantsPicture = screenshot !== undefined || command === 'screenshot' || command === 'shot'
  if (wantsPicture) refuseRepeatPicture(args, crop)

  const output = drive(session, { ...actionFor(command, args), screenshot, crop })
  console.log(printable(command, output))
  notePace(command, wantsPicture, framing(args, crop))
}

/** Which commands change the app, and so make a new picture worth taking. */
const ACTING_COMMANDS = [
  'click',
  'dblclick',
  'rightclick',
  'drag',
  'type',
  'key',
  'press',
  'scroll',
  'pane'
]

function readPace(): Pace {
  try {
    return JSON.parse(readFileSync(paths.pace, 'utf8')) as Pace
  } catch {
    return emptyPace()
  }
}

/** Refuse a picture of a screen that has already been photographed. */
function refuseRepeatPicture(args: string[], crop: Region | undefined): void {
  const refusal = refusePicture(readPace(), framing(args, crop))
  if (refusal !== null) throw new Error(refusal)
}

/** How a screenshot was framed, so one closer look is told from a repeat. */
function framing(args: string[], crop: Region | undefined): string {
  const of = optional(args, '--of')
  if (of !== undefined) return `of:${of}`
  if (crop !== undefined) return `crop:${crop.x},${crop.y},${crop.width},${crop.height}`
  return 'full'
}

function notePace(command: string, tookPicture: boolean, frame: string): void {
  let pace = readPace()
  if (ACTING_COMMANDS.includes(command)) pace = noteAction(pace)
  if (tookPicture) pace = notePicture(pace, frame, latestShot())
  writeFileSync(paths.pace, JSON.stringify(pace), 'utf8')
}

/** The screenshot just written, by the numbering `nextShotPath` hands out. */
function latestShot(): string | null {
  const taken = readdirSync(paths.shots)
    .filter((name) => name.endsWith('.png'))
    .sort()
  const last = taken[taken.length - 1]
  if (last === undefined) return null
  return join(paths.shots, last)
}

/**
 * The driver's JSON, as the command that asked for it reads best.
 *
 * `probe` and the pane commands answer with a whole snapshot of the app, which
 * is a tree; everything else answers with a line or two, which is already
 * readable as JSON.
 */
function printable(command: string, output: string): string {
  if (command === 'panes') return renderPaneTypes(parse<{ types: PaneTypeEntry[] }>(output).types)
  if (command === 'screenshot' || command === 'shot') {
    // The path, and nothing else: it is the one thing to do something with, and
    // what to do with it is read it.
    return `screenshot: ${parse<{ shot: string }>(output).shot}`
  }
  if (command !== 'probe' && command !== 'status' && command !== 'pane') return output

  const snapshot = parse<Snapshot & Record<string, unknown>>(output)
  // An error before the snapshot was taken (no such pane type, debug hooks
  // missing) has no tree to draw.
  if (snapshot.tree === undefined) return output

  const lines: string[] = []
  const outcome = outcomeLine(snapshot)
  if (outcome !== null) lines.push(outcome, '')
  lines.push(renderSnapshot(snapshot))
  if (typeof snapshot.screenshot === 'string') lines.push('', `screenshot: ${snapshot.screenshot}`)
  return lines.join('\n')
}

/** What a pane command did, above the tree it resulted in. */
function outcomeLine(snapshot: Record<string, unknown>): string | null {
  if (typeof snapshot.opened === 'string') return `opened ${snapshot.opened}`
  if (typeof snapshot.swapped === 'string') return `swapped into ${snapshot.swapped}`
  if (typeof snapshot.split === 'string') return `split ${snapshot.split}`
  if (Array.isArray(snapshot.closed)) return `closed ${snapshot.closed.join(' ')}`
  if (snapshot.dismissedSetup === true) return 'dismissed the first-run wizard'
  return null
}

function parse<T>(output: string): T {
  try {
    return JSON.parse(output) as T
  } catch {
    throw new Error(`the driver answered with something that is not JSON:\n${output}`)
  }
}

/** The flags that are followed by a value, as opposed to standing alone. */
const VALUE_FLAGS = [
  '--screenshot',
  '--shot',
  '--of',
  '--crop',
  '--at',
  '--in',
  '--split',
  '--model',
  '--title',
  '--body',
  '--label',
  '--repo'
]

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

  if (command === 'screenshot' || command === 'shot') {
    return {
      action: 'shot',
      path: nextShotPath(rest[0]),
      target: optional(args, '--of'),
      crop: cropOf(args)
    }
  }
  // `status` is the same question as `probe`, asked before there was a tree to
  // answer it with.
  if (command === 'probe' || command === 'status') {
    return { action: 'probe', filter: rest[0] }
  }
  if (command === 'panes') {
    return { action: 'panes' }
  }
  if (command === 'pane') {
    requireArgument(rest[0], 'pane <type> [--split row|column] [--in <pane>] [--close]')
    return {
      action: 'pane',
      paneTypeId: rest[0],
      close: args.includes('--close'),
      split: splitDirection(args),
      inLeaf: optional(args, '--in')
    }
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
  if (command === 'press' || command === 'key') {
    requireArgument(rest[0], 'press <chord> [chord …]')
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
  throw new Error(`unknown command: ${command} (try "qa help")`)
}

/** `--crop x,y,w,h`, when only one part of the window is the question. */
function cropOf(args: string[]): Region | undefined {
  const value = optional(args, '--crop')
  if (value === undefined) return undefined
  return parseRegion(value)
}

/** `--split row|column`, the orientation a new pane is opened in. */
function splitDirection(args: string[]): string | undefined {
  const value = optional(args, '--split')
  if (value === undefined) return undefined
  if (value === 'row' || value === 'column') return value
  throw new Error(`--split takes row or column, got ${value}`)
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
    [
      join(repoRoot, 'scripts', 'qa', 'drive.ts'),
      String(session.port),
      paths.refs,
      JSON.stringify(command)
    ],
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

/**
 * What the app has complained about, from both of its halves.
 *
 * The renderer's own buffer and the main process's stdout are different files
 * with different failures in them — git, nvim and the agents only ever appear in
 * the second — and a fault usually only makes sense with both in front of you.
 */
function showLogs(args: string[]): void {
  const count = Number(positional(args)[0] ?? 40)
  const onlyMain = args.includes('--main')
  const onlyRenderer = args.includes('--renderer')

  if (!onlyMain) {
    const entries = parse<Array<{ level: string; at: string; text: string }>>(
      drive(requireSession(), { action: 'console' })
    )
    console.log(`renderer (${entries.length} entries, last ${Math.min(count, entries.length)}):`)
    for (const entry of entries.slice(-count)) {
      console.log(`  [${entry.level}] ${entry.at.slice(11, 19)} ${entry.text}`)
    }
  }
  if (onlyRenderer) return

  const contents = readFileSync(paths.appLog, 'utf8').split('\n')
  if (!onlyMain) console.log('')
  console.log(`main process (${paths.appLog}, last ${count} lines):`)
  for (const line of contents.slice(-count)) console.log(`  ${line}`)
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

const CHARTER_DIR = join(repoRoot, '.claude', 'skills', 'grove-debug', 'charters')

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

Read .claude/skills/grove-debug/SKILL.md first. It has the harness commands, how to
see what is on screen, and what is worth reporting.

A session is already running. Do not start, stop or rebuild one.

Every harness command is "bun run qa <command>". Nothing else can be run, and a
command outside that list stops the run dead rather than asking anyone.

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

Work in small loops: act, probe, decide. The probe is a tree of the panes and
what is inside them, which is what tells you where you are; take a screenshot
when the question is visual — alignment, overlap, a panel that went blank — and
read the PNG with the Read tool when you do. "bun run qa screenshot <label>
--crop x,y,w,h" cuts out one part of the window when the detail is small.

Never open a browser, and never pass --web to anything. There is no desktop to
open one on and nobody watching it: everything you need is the harness, the
report, and gh's ordinary terminal output.

Note anything that is broken, confusing, inconsistent, ugly, slow, or that made
you guess what to do — the last one matters as much as the crashes.

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
        // The same harness, spelled the way `bun run` itself echoes it. A run
        // that shortens to this form is asking for exactly what is already
        // allowed above, and being stopped for it costs a whole session.
        'Bash(bun scripts/qa.ts:*)',
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
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'], env: exploreEnv() }
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

/**
 * The environment an exploring agent gets.
 *
 * `gh issue view --web` is inside the permissions a run needs, and it opens a
 * real browser on whoever's desktop launched this — which nobody is watching,
 * and which has nothing to do with the app under test. Pointing every browser
 * launch at `true` makes it a no-op instead of a window, so the run reads the
 * terminal output it should have asked for in the first place.
 */
function exploreEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    BROWSER: '/usr/bin/true',
    GH_BROWSER: '/usr/bin/true'
  }
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
 *              --screenshot .grove-qa/shots/012-split.png
 *
 * `--body` takes a file when it names one, and the text itself otherwise.
 */
function fileFinding(args: string[]): void {
  const title = optional(args, '--title')
  const form = 'finding --title <title> --body <file|text> [--label …] [--screenshot …]'
  requireArgument(title, form)
  const body = optional(args, '--body')
  requireArgument(body, form)

  ensureLabel()
  const images = [...all(args, '--screenshot'), ...all(args, '--shot')].map(uploadScreenshot)
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

/**
 * Show on an issue that its fix works: a comment with what changed and the
 * screenshots that prove it.
 *
 *   qa evidence --issue 23 --body "The cmdline now floats…"
 *               --screenshot .grove-qa/shots/004-before.png
 *               --screenshot .grove-qa/shots/009-after.png
 */
function postEvidence(args: string[]): void {
  const issue = optional(args, '--issue')
  const form = 'evidence --issue <n> --body <file|text> [--screenshot …]'
  requireArgument(issue, form)
  const body = optional(args, '--body')
  requireArgument(body, form)

  const images = [...all(args, '--screenshot'), ...all(args, '--shot')].map(uploadScreenshot)
  const sections = [bodyText(body as string)]
  if (images.length > 0) {
    sections.push(images.map((url) => `![screenshot](${url})`).join('\n\n'))
  }
  sections.push(`---\n\n*Verified by Claude on ${headCommit(process.cwd())}.*`)

  const commented = spawnSync(
    'gh',
    ['issue', 'comment', issue as string, '--repo', FINDINGS_REPO, '--body', sections.join('\n\n')],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (commented.status !== 0) {
    throw new Error(`could not comment on #${issue}:\n${commented.stderr.trim()}`)
  }
  console.log(commented.stdout.trim())
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

/** The short hash checked out in a directory — the harness's own checkout unless told otherwise. */
function headCommit(directory: string = repoRoot): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: directory,
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
  return value
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase()
    .slice(0, 40)
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

Seeing:

  probe [filter]                 the pane tree: what is open, what has focus,
                                 and a ref for everything inside it
  screenshot [label] [--of <target>] [--crop x,y,w,h]
                                 a picture, for what only a picture shows —
                                 alignment, overlap, a panel that went blank.
                                 Refused when nothing has happened since the last
  logs [--main|--renderer] [n]   what the app has complained about
  nvim <lua>                     run lua in the editor; its text is not in the DOM

Acting:

  panes                          every pane type, and whether one is open
  pane <type> [--split row|column] [--in <pane>] [--close]
                                 open one without hunting for the affordance
  click <target>                 click it; also dblclick, rightclick
  drag <from> <to>               press, move, release — gutters included
  type <text>                    type into whatever has focus
  press <chord> [chord …]        Escape, Control+s, g
  scroll <dy> [--at <target>]    wheel
  wait <target> [--gone]         until it is there, or until it is not
  eval <expression>              one expression in the renderer

Every action takes --screenshot <label>, which photographs the result in the
same connection the action ran in. A menu closes when the driver disconnects, so
this is the only way to see one.

  explore [scope] [--dry-run] [--model <model>]
                                 hand the app to a Claude Code instance to test
                                 (sonnet by default; haiku and opus also work)
  finding --title … --body …     file what it found, screenshot attached
  evidence --issue <n> --body …  show on an issue that its fix works
  charters                       the charters that ship with the harness

Targets are an accessible name ("New session"), or an id \`probe\` printed: a ref
(e12), a pane (leaf-3), a gutter (split-1:0). Also at=820,460 for a bare point,
and role=button:Save, text=…, testid=…, css=… when a name is ambiguous.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
