#!/usr/bin/env bun
// The QA harness: a running Grove native, and a command surface for using it the
// way a person does.
//
// End-to-end checks assert on what can be asserted on. This is for everything
// else — whether a divider feels right when it is dragged, whether the GitHub view
// is usable, whether vim behaves under a real keyboard — and it exists so that job
// can be handed to a model instead of a person. `qa explore` starts one.
//
//   bun run qa start                     launch a session on a display of its own
//   bun run qa click "Problems"          act, by the text on screen or a point
//   bun run qa drag at=900,300 at=700,300
//   bun run qa screenshot split-panes    look
//   bun run qa stop
//
// The session is `native/target/release/grove_native` on a headless gamescope
// (`qa/display.ts`), with its own profile and its own suite daemon
// (`qa/environment.ts`), driven through XTEST (`qa/input.ts`). Text on screen is
// found by reading a screenshot (`qa/ocr.ts`).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDemoRepo, demoWorktreePathFor } from '../tests/e2e/fixtures/demoRepo'
import {
  displayIsRunning,
  killGroup,
  missingDisplayTools,
  openAppend,
  processIsRunning,
  SCREEN,
  startHeadlessDisplay,
  stopHeadlessDisplay
} from './qa/display'
import { appEnvironment, runtimeBase, sessionPaths } from './qa/environment'
import {
  AI_LABEL,
  bodyText,
  ensureLabel,
  FINDINGS_REPO,
  github,
  headCommit,
  slug,
  uploadScreenshot
} from './qa/github'
import { Input, type ButtonName, type Point } from './qa/input'
import { centerOf, findText, readWords, type Box } from './qa/ocr'
import { emptyPace, noteAction, notePicture, refusePicture, type Pace } from './qa/pace'
import { describeTarget, parseRegion, parseTarget, type Region } from './qa/targets'
import { renderTranscript } from './qa/transcript'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const nativeRoot = join(repoRoot, 'native')

/** What a run leaves behind: profile, screenshots, logs, reports. Gitignored. */
const QA_ROOT = join(repoRoot, '.grove-qa')

const session = sessionPaths(repoRoot, QA_ROOT, runtimeBase(process.env))

/**
 * The remote the demo repo is given, so the GitHub surfaces have something real.
 *
 * A scratch repository, and the QA agent is expected to write to it: the issues,
 * branches and pull requests in there were made by a test run.
 */
const SANDBOX_REMOTE = 'https://github.com/neoworks-dev/grove-qa-sandbox.git'

const paths = {
  session: join(QA_ROOT, 'session.json'),
  shots: join(QA_ROOT, 'shots'),
  reports: join(QA_ROOT, 'reports'),
  appLog: join(QA_ROOT, 'app.log'),
  displayLog: join(QA_ROOT, 'display.log'),
  daemonLog: join(QA_ROOT, 'daemon.log'),
  pace: join(QA_ROOT, 'pace.json'),
  reading: join(QA_ROOT, 'reading.png'),
  host: hostBinary(),
  bundle: join(nativeRoot, 'dist', 'grove-native.js')
}

/** The host to run: `GROVE_QA_HOST` names another build, such as one with timing in it, else the release build. */
function hostBinary(): string {
  const chosen = process.env.GROVE_QA_HOST
  if (chosen !== undefined && chosen !== '') {
    return chosen
  }
  return join(nativeRoot, 'target', 'release', 'grove_native')
}

const CHARTER_DIR = join(repoRoot, '.claude', 'skills', 'grove-debug', 'charters')

/** How long the app gets to open its window, and its sidecar to answer. */
const WINDOW_TIMEOUT_MS = 30_000
const SIDECAR_TIMEOUT_MS = 30_000

/** How long an action is given to reach the screen before anything looks at it. */
const SETTLE_MS = 350

interface Session {
  display: string
  displayPid: number
  appPid: number
  window: string
  daemon: boolean
  startedAt: string
}

/** Runs the command named on the command line. */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === undefined || command === 'help') {
    usage()
    return
  }
  mkdirSync(QA_ROOT, { recursive: true })

  if (command === 'start') {
    return start(args)
  }
  if (command === 'stop') {
    return stop()
  }
  if (command === 'restart') {
    await stop()
    return start(args)
  }
  if (command === 'explore') {
    return explore(args)
  }
  if (command === 'finding') {
    return fileFinding(args)
  }
  if (command === 'evidence') {
    return postEvidence(args)
  }
  if (command === 'charters') {
    return listCharters()
  }
  if (command === 'logs') {
    return showLogs(args)
  }
  return act(command, args)
}

// ------------------------------------------------------------------ sessions

/**
 * Brings up a session: a headless display, a throwaway suite daemon, and the
 * app on the session's profile with the demo repo open.
 *
 * The bundle is rebuilt every time, which takes a second and means the session
 * runs the checkout's UI as it is now. The Rust host is rebuilt only with
 * `--build`, because that takes minutes.
 */
async function start(args: string[]): Promise<void> {
  const running = readSession()
  if (running !== null && sessionIsAlive(running)) {
    console.log('a session is already running — "qa stop" first, or "qa probe" to see it')
    return
  }
  if (running !== null) {
    await stop()
  }
  const missing = missingDisplayTools()
  if (missing.length > 0) {
    throw new Error(`the harness needs ${missing.join(', ')} on PATH`)
  }
  if (args.includes('--fresh')) {
    await resetProfile()
  }
  if (args.includes('--build')) {
    buildHost()
  }
  requireHost()
  buildBundle()
  await prepareProfile()

  const display = await startHeadlessDisplay(QA_ROOT, paths.displayLog)
  const environment = appEnvironment(process.env, {
    checkout: repoRoot,
    paths: session,
    display: display.display,
    suite: findSuite()
  })
  let daemon = false
  if (!args.includes('--no-daemon')) {
    daemon = startDaemon(environment)
  }

  const appPid = launchApp(environment)
  const partial: Session = {
    display: display.display,
    displayPid: display.pid,
    appPid,
    window: '',
    daemon,
    startedAt: new Date().toISOString()
  }
  writeSession(partial)

  const window = await waitForWindow(display.display, appPid)
  writeSession({ ...partial, window })
  await waitForSidecar()
  writeFileSync(paths.pace, JSON.stringify(emptyPace()), 'utf8')

  console.log(`grove native on ${display.display} (headless), pid ${appPid}`)
  console.log(`profile ${session.profile}`)
  console.log(`repo    ${session.demoRepo}`)
  if (!daemon) {
    console.log('no suite daemon: agents cannot run in this session')
  }
}

/** Stops the app and everything it spawned, the daemon, and the display. */
async function stop(): Promise<void> {
  const running = readSession()
  if (running === null) {
    console.log('no session')
    return
  }
  killGroup(running.appPid)
  if (running.daemon) {
    stopDaemon()
  }
  stopHeadlessDisplay(running.displayPid)
  await rm(paths.session, { force: true })
  console.log('stopped the app, its daemon and its display')
}

/** The session the last `start` recorded, whether or not it is still up. */
function readSession(): Session | null {
  if (!existsSync(paths.session)) {
    return null
  }
  return JSON.parse(readFileSync(paths.session, 'utf8')) as Session
}

function writeSession(value: Session): void {
  writeFileSync(paths.session, JSON.stringify(value, null, 2), 'utf8')
}

/** Whether both the display and the app of a session are still running. */
function sessionIsAlive(value: Session): boolean {
  return displayIsRunning(value.displayPid) && processIsRunning(value.appPid)
}

/** The running session, or an error saying how to get one. */
function requireSession(): Session {
  const running = readSession()
  if (running === null) {
    throw new Error('no session is running — "qa start" first')
  }
  if (!displayIsRunning(running.displayPid)) {
    throw new Error('the session\'s display is gone — "qa stop", then "qa start"')
  }
  if (!processIsRunning(running.appPid)) {
    throw new Error(`the app has exited — "qa logs" says why; "qa restart" brings it back`)
  }
  return running
}

/** Starts the host on the session's display, in a process group of its own. */
function launchApp(environment: Record<string, string>): number {
  const output = openAppend(paths.appLog)
  const child = spawn(
    paths.host,
    ['--bundle', paths.bundle, '--width', String(SCREEN.width), '--height', String(SCREEN.height)],
    { cwd: nativeRoot, env: environment, detached: true, stdio: ['ignore', output, output] }
  )
  child.unref()
  if (child.pid === undefined) {
    throw new Error(`could not start ${paths.host}`)
  }
  return child.pid
}

/** Waits for the app's window to be mapped on the display, and returns its id. */
async function waitForWindow(display: string, appPid: number): Promise<string> {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processIsRunning(appPid)) {
      throw new Error(`the app exited while starting — see ${paths.appLog}`)
    }
    const found = spawnSync('xdotool', ['search', '--onlyvisible', '--pid', String(appPid)], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: display }
    })
    const window = found.stdout.trim().split('\n').filter(Boolean).pop()
    if (window !== undefined) {
      return window
    }
    await Bun.sleep(200)
  }
  throw new Error(`no window appeared within ${WINDOW_TIMEOUT_MS / 1000}s — see ${paths.appLog}`)
}

/** Waits for the sidecar to say it is ready, so the first command finds files listed. */
async function waitForSidecar(): Promise<void> {
  const deadline = Date.now() + SIDECAR_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (readFileSync(paths.appLog, 'utf8').includes('[sidecar] ready')) {
      return
    }
    await Bun.sleep(200)
  }
  console.warn(`the sidecar did not report ready within ${SIDECAR_TIMEOUT_MS / 1000}s — "qa logs"`)
}

// --------------------------------------------------------------- building

/** Builds the Svelte bundle the host runs. */
function buildBundle(): void {
  const built = spawnSync('bun', ['build.mjs'], { cwd: nativeRoot, encoding: 'utf8' })
  if (built.status !== 0) {
    throw new Error(`the bundle did not build:\n${built.stderr.trim()}`)
  }
}

/**
 * Builds the Rust host. A worktree with no `target/` yet is seeded from the main
 * checkout's, which `host.sh` copies as a reflink, so GPUI is not compiled again.
 */
function buildHost(): void {
  const environment: Record<string, string> = { ...(process.env as Record<string, string>) }
  const shared = mainCheckoutTarget()
  if (shared !== null) {
    environment.SHARED = shared
  }
  const built = spawnSync('bash', [join(nativeRoot, 'scripts', 'host.sh')], {
    cwd: nativeRoot,
    env: environment,
    stdio: 'inherit'
  })
  if (built.status !== 0) {
    throw new Error('the host did not build')
  }
}

/** The main checkout's `native/target`, when this is another worktree and it has one. */
function mainCheckoutTarget(): string | null {
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  const first = listed.stdout.split('\n').find((line) => line.startsWith('worktree '))
  if (first === undefined) {
    return null
  }
  const target = join(first.slice('worktree '.length), 'native', 'target')
  if (target === join(nativeRoot, 'target') || !existsSync(join(target, 'release', 'deps'))) {
    return null
  }
  return target
}

function requireHost(): void {
  if (!existsSync(paths.host)) {
    throw new Error(`no host at ${paths.host} — "qa start --build" builds it`)
  }
  if (!existsSync(join(nativeRoot, 'node_modules'))) {
    throw new Error(`native/ has no node_modules — run "bun install" in ${nativeRoot}`)
  }
}

// ---------------------------------------------------------------- profile

/** Creates the profile's directories and the demo repo, keeping both when they exist. */
async function prepareProfile(): Promise<void> {
  for (const name of ['config', 'data', 'state', 'cache', 'tmp']) {
    mkdirSync(join(session.profile, name), { recursive: true })
  }
  mkdirSync(session.runtime, { recursive: true, mode: 0o700 })
  if (existsSync(join(session.demoRepo, '.git'))) {
    return
  }
  await createDemoRepo(session.demoRepo)
  wireSandboxRemote(session.demoRepo)
}

/** Throws the profile away, demo repo included, so the next start is a first run. */
async function resetProfile(): Promise<void> {
  await rm(demoWorktreePathFor(session.demoRepo), { recursive: true, force: true })
  await rm(session.profile, { recursive: true, force: true })
  await rm(session.runtime, { recursive: true, force: true })
}

/**
 * Gives the demo repo the sandbox as its origin, and puts its history there.
 *
 * Without a remote the GitHub views have nothing to show and nothing to do: no
 * pull requests, no issues, no branch to open one from.
 */
function wireSandboxRemote(demoRoot: string): void {
  const git = (...args: string[]) => spawnSync('git', ['-C', demoRoot, ...args], { encoding: 'utf8' })
  git('remote', 'add', 'origin', SANDBOX_REMOTE)
  const pushed = git('push', '--force', '-u', 'origin', 'main')
  if (pushed.status !== 0) {
    console.warn(`could not push the demo repo to the sandbox:\n${pushed.stderr.trim()}`)
  }
}

// ------------------------------------------------------------------ daemon

/**
 * The `neo` executable, found the way the app finds it (`native/src/suite.rs`):
 * GROVE_NEO, then NEO_ROOT, then a neoworks-harness checkout beside this one.
 */
function findSuite(): string {
  const explicit = process.env.GROVE_NEO
  if (explicit !== undefined && explicit.length > 0) {
    return explicit
  }
  const root = process.env.NEO_ROOT
  if (root !== undefined && root.length > 0) {
    return join(root, 'bin', 'neo')
  }
  let directory = repoRoot
  while (directory !== dirname(directory)) {
    const sibling = join(directory, 'neoworks-harness', 'bin', 'neo')
    if (existsSync(sibling)) {
      return sibling
    }
    directory = dirname(directory)
  }
  return 'neo'
}

/** Starts the session's own suite daemon; says so and goes on without one when it cannot. */
function startDaemon(environment: Record<string, string>): boolean {
  const started = spawnSync(environment.GROVE_NEO, ['up'], { env: environment, encoding: 'utf8' })
  writeFileSync(paths.daemonLog, `${started.stdout}${started.stderr}`, 'utf8')
  if (started.status !== 0) {
    console.warn(`the suite daemon did not start, see ${paths.daemonLog}`)
    return false
  }
  return true
}

/** Stops the session's suite daemon. */
function stopDaemon(): void {
  const environment = appEnvironment(process.env, {
    checkout: repoRoot,
    paths: session,
    display: '',
    suite: findSuite()
  })
  spawnSync(environment.GROVE_NEO, ['down'], { env: environment, stdio: 'ignore' })
}

// ----------------------------------------------------------------- acting

/** Which commands change the app, and so make a new picture worth taking. */
const ACTING_COMMANDS = ['click', 'dblclick', 'rightclick', 'drag', 'type', 'press', 'scroll']

/** Runs one action or look against the running session. */
async function act(command: string, args: string[]): Promise<void> {
  const running = requireSession()
  const input = new Input(running.display, running.window)

  if (command === 'probe') {
    return probe(running, args)
  }
  if (command === 'screenshot') {
    screenshotCommand(running, args)
    return
  }
  if (command === 'wait') {
    return waitFor(running, args)
  }
  if (!ACTING_COMMANDS.includes(command)) {
    throw new Error(`no such command: ${command} — "qa help" lists them`)
  }

  const what = perform(command, args, running, input)
  console.log(what)
  notePace(true)
  const label = optional(args, '--screenshot')
  if (label === undefined) {
    return
  }
  await Bun.sleep(SETTLE_MS)
  const shot = takeScreenshot(running, nextShotPath(label), undefined)
  notePace(false, 'full', shot)
  console.log(`screenshot: ${shot}`)
}

/** Carries out one acting command, and says what it did. */
function perform(command: string, args: string[], running: Session, input: Input): string {
  const words = positional(args)
  if (command === 'type') {
    requireArgument(words[0], 'type <text>')
    input.type(words.join(' '))
    return `typed ${JSON.stringify(words.join(' '))}`
  }
  if (command === 'press') {
    requireArgument(words[0], 'press <chord> [chord …]')
    input.press(words)
    return `pressed ${words.join(' ')}`
  }
  if (command === 'scroll') {
    requireArgument(words[0], 'scroll <pixels> [--at <target>]')
    const at = optional(args, '--at')
    let point: Point = { x: Math.round(SCREEN.width / 2), y: Math.round(SCREEN.height / 2) }
    if (at !== undefined) {
      point = locate(running, at, args)
    }
    input.scroll(point, Number(words[0]))
    return `scrolled ${words[0]} at ${point.x},${point.y}`
  }
  if (command === 'drag') {
    requireArgument(words[1], 'drag <from> <to>')
    const from = locate(running, words[0], args)
    const to = locate(running, words[1], [])
    input.drag(from, to)
    return `dragged ${from.x},${from.y} to ${to.x},${to.y}`
  }
  requireArgument(words[0], `${command} <target>`)
  const point = locate(running, words[0], args)
  const { button, count } = clickKind(command)
  input.click(point, button, count)
  return `${command}ed ${describeTarget(parseTarget(words[0]))} at ${point.x},${point.y}`
}

/** Which button, and how many presses, a click command means. */
function clickKind(command: string): { button: ButtonName; count: number } {
  if (command === 'dblclick') {
    return { button: 'left', count: 2 }
  }
  if (command === 'rightclick') {
    return { button: 'right', count: 1 }
  }
  return { button: 'left', count: 1 }
}

/**
 * The point a target names: the point itself, or the middle of the text on
 * screen. Several matches are an error listing them, unless `--nth` picks one.
 */
function locate(running: Session, raw: string, args: string[]): Point {
  const target = parseTarget(raw)
  if (target.kind === 'point') {
    return { x: target.x, y: target.y }
  }
  const found = findOnScreen(running, target.text)
  if (found.length === 0) {
    throw new Error(`nothing on screen reads "${target.text}" — "qa screenshot" to look, or use at=x,y`)
  }
  const nth = optional(args, '--nth')
  if (nth !== undefined) {
    const chosen = found[Number(nth) - 1]
    if (chosen === undefined) {
      throw new Error(`"${target.text}" is on screen ${found.length} times, so there is no --nth ${nth}`)
    }
    return centerOf(chosen)
  }
  if (found.length > 1) {
    const places = found.map((box, index) => `  ${index + 1}. ${describeBox(box)}`).join('\n')
    throw new Error(`"${target.text}" is on screen ${found.length} times; pick one with --nth:\n${places}`)
  }
  return centerOf(found[0])
}

/** Where a phrase is on screen right now. */
function findOnScreen(running: Session, text: string): Box[] {
  capture(running.window, running.display, paths.reading)
  return findText(readWords(paths.reading), text)
}

function describeBox(box: Box): string {
  return `at ${box.x},${box.y}  ${box.width}x${box.height}`
}

/**
 * The session at a glance: whether it is up, where, and how many errors its log
 * holds. With text, also where that text is on screen.
 */
async function probe(running: Session, args: string[]): Promise<void> {
  const log = readFileSync(paths.appLog, 'utf8')
  const errors = errorLines(log)
  console.log(`grove native  ${SCREEN.width}x${SCREEN.height}  display=${running.display}  pid=${running.appPid}`)
  console.log(`repo=${session.demoRepo}  daemon=${running.daemon ? 'up' : 'none'}  errors=${errors.length}`)
  for (const line of errors.slice(-5)) {
    console.log(`  ${line}`)
  }
  const text = positional(args).join(' ')
  if (text.length === 0) {
    return
  }
  const found = findOnScreen(running, text)
  if (found.length === 0) {
    console.log(`"${text}" is not on screen`)
    return
  }
  for (const [index, box] of found.entries()) {
    const center = centerOf(box)
    console.log(`${index + 1}. "${text}" ${describeBox(box)}  center at=${center.x},${center.y}`)
  }
}

/** Waits until a text is on screen, or with `--gone` until it is not. */
async function waitFor(running: Session, args: string[]): Promise<void> {
  const text = positional(args).join(' ')
  requireArgument(text, 'wait <text> [--gone] [--timeout <seconds>]')
  const gone = args.includes('--gone')
  let seconds = 15
  const timeout = optional(args, '--timeout')
  if (timeout !== undefined) {
    seconds = Number(timeout)
  }
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const present = findOnScreen(running, text).length > 0
    if (present !== gone) {
      console.log(`"${text}" is ${gone ? 'gone' : 'on screen'}`)
      return
    }
    await Bun.sleep(400)
  }
  throw new Error(`"${text}" was still ${gone ? 'on screen' : 'missing'} after ${seconds}s`)
}

// ------------------------------------------------------------ screenshots

/** `qa screenshot [label] [--crop x,y,w,h] [--again]`. */
function screenshotCommand(running: Session, args: string[]): void {
  const cropText = optional(args, '--crop')
  let crop: Region | undefined = undefined
  if (cropText !== undefined) {
    crop = parseRegion(cropText)
  }
  const frame = framing(crop)
  if (!args.includes('--again')) {
    const refusal = refusePicture(readPace(), frame)
    if (refusal !== null) {
      throw new Error(`${refusal}\nWhen the app changed by itself (it finished loading), add --again.`)
    }
  }
  const shot = takeScreenshot(running, nextShotPath(positional(args)[0]), crop)
  notePace(false, frame, shot)
  console.log(`screenshot: ${shot}`)
}

/** Photographs the window, or one region of it, to a file. */
function takeScreenshot(running: Session, path: string, crop: Region | undefined): string {
  capture(running.window, running.display, path)
  if (crop === undefined) {
    return path
  }
  const geometry = `${crop.width}x${crop.height}+${crop.x}+${crop.y}`
  const cropped = spawnSync('magick', [path, '-crop', geometry, '+repage', path], { encoding: 'utf8' })
  if (cropped.status !== 0) {
    throw new Error(`could not crop ${path}: ${cropped.stderr.trim()}`)
  }
  return path
}

/** Reads the window's pixels into a PNG. */
function capture(window: string, display: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const taken = spawnSync('import', ['-window', window, path], {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: display }
  })
  if (taken.status !== 0) {
    throw new Error(`could not read the window: ${taken.stderr.trim()}`)
  }
}

/** The next numbered path in the shots directory. */
function nextShotPath(label: string | undefined): string {
  mkdirSync(paths.shots, { recursive: true })
  const count = readdirSync(paths.shots).filter((name) => name.endsWith('.png')).length
  let name = 'shot'
  if (label !== undefined) {
    name = slug(label)
  }
  return join(paths.shots, `${String(count + 1).padStart(3, '0')}-${name}.png`)
}

function readPace(): Pace {
  try {
    return JSON.parse(readFileSync(paths.pace, 'utf8')) as Pace
  } catch {
    return emptyPace()
  }
}

/** How a screenshot was framed, so one closer look is told from a repeat. */
function framing(crop: Region | undefined): string {
  if (crop === undefined) {
    return 'full'
  }
  return `crop:${crop.x},${crop.y},${crop.width},${crop.height}`
}

/** Records an action, a picture, or both, in the pace file. */
function notePace(acted: boolean, frame?: string, shot?: string): void {
  let pace = readPace()
  if (acted) {
    pace = noteAction(pace)
  }
  if (frame !== undefined && shot !== undefined) {
    pace = notePicture(pace, frame, shot)
  }
  writeFileSync(paths.pace, JSON.stringify(pace), 'utf8')
}

// -------------------------------------------------------------------- logs

/** Lines of the app's log that report something going wrong. */
function errorLines(log: string): string[] {
  return log
    .split('\n')
    .filter((line) => /\[error\]|panicked|error:|uncaught|unhandled|failed/i.test(line))
}

/**
 * `qa logs [n] [--errors]`: the end of the app's log, which carries the host,
 * the UI's console and the sidecar's stderr in the order they happened.
 */
function showLogs(args: string[]): void {
  if (!existsSync(paths.appLog)) {
    console.log('no log yet — "qa start" first')
    return
  }
  let count = 80
  const given = positional(args)[0]
  if (given !== undefined) {
    count = Number(given)
  }
  let lines = readFileSync(paths.appLog, 'utf8').split('\n')
  if (args.includes('--errors')) {
    lines = errorLines(lines.join('\n'))
  }
  console.log(lines.slice(-count).join('\n'))
}

// ----------------------------------------------------------------- explore

/**
 * Hands the running session to a Claude Code instance to test.
 *
 * The agent gets the skill, a charter for what to cover, and the harness; it has
 * no session context to spend. It can read the repo and drive the harness; it
 * cannot edit anything. What it produces is issues, not fixes.
 *
 *   qa explore                     the whole app
 *   qa explore "the GitHub pane"   one part of it
 *   qa explore panes               a charter that ships with the harness
 */
function explore(args: string[]): void {
  const scope = positional(args)[0]
  let model = optional(args, '--model')
  if (model === undefined) {
    model = 'sonnet'
  }
  requireSession()

  let charter = 'Explore the whole app. Cover every surface you can reach.'
  let label = 'whole-app'
  if (scope !== undefined) {
    charter = charterText(scope)
    label = scope
  }
  const report = join(paths.reports, `${stamp()}-${slug(label)}.md`)
  mkdirSync(paths.reports, { recursive: true })

  let filing = 'Do not file any issues — this is a dry run. The report is the deliverable.'
  if (!args.includes('--dry-run')) {
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

Pick out the ones in your area and read them. A finding that is already filed is
not a finding — say in your report that you saw it again. An open issue is also a
lead: see whether it is still true, and what is next to it that nobody has filed.

What to cover:

${charter}

Work in small loops: act, look, decide. Take a screenshot and read the PNG with the
Read tool to see where you are; "bun run qa screenshot <label> --crop x,y,w,h" cuts
out one part of the window when the detail is small. Click by the text you see
("bun run qa click Problems"), or by a point read off the screenshot (at=x,y).

Never open a browser, and never pass --web to anything.

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
      // Nothing outside this list can be reached, and a run has nobody to answer
      // a permission prompt — anything missing here stops it dead rather than
      // asking. `Edit` is on it because the report is kept up to date as the run
      // goes, which is an edit after the first write.
      [
        'Read',
        'Glob',
        'Grep',
        'Write',
        'Edit',
        'Bash(bun run qa:*)',
        'Bash(bun scripts/qa.ts:*)',
        'Bash(gh issue:*)',
        'Bash(gh label:*)'
      ].join(','),
      '--autocompact',
      '200000',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '-p',
      prompt
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      // `gh issue view --web` would open a browser on whoever's desktop launched
      // this; pointing every browser launch at `true` makes it a no-op.
      env: { ...(process.env as Record<string, string>), BROWSER: '/usr/bin/true', GH_BROWSER: '/usr/bin/true' }
    }
  )

  console.log(`exploring: ${label}\n`)
  void renderTranscript(child.stdout)
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

/** A charter by name from the skill's directory, or the text itself. */
function charterText(name: string): string {
  const path = join(CHARTER_DIR, `${name}.md`)
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }
  return name
}

function listCharters(): void {
  if (!existsSync(CHARTER_DIR)) {
    console.log('no charters')
    return
  }
  for (const entry of readdirSync(CHARTER_DIR)) {
    if (!entry.endsWith('.md')) {
      continue
    }
    const name = entry.replace(/\.md$/, '')
    const firstLine = readFileSync(join(CHARTER_DIR, entry), 'utf8').split('\n')[0]
    console.log(`${name.padEnd(12)} ${firstLine.replace(/^#\s*/, '')}`)
  }
}

// ---------------------------------------------------------------- findings

/**
 * Files one finding, with its screenshots.
 *
 *   qa finding --title "The tab strip loses the active tab on a split"
 *              --body report.md --label bug --label area:panes
 *              --screenshot .grove-qa/shots/012-split.png
 */
function fileFinding(args: string[]): void {
  const form = 'finding --title <title> --body <file|text> [--label …] [--screenshot …]'
  const title = optional(args, '--title')
  requireArgument(title, form)
  const body = optional(args, '--body')
  requireArgument(body, form)

  ensureLabel()
  const images = all(args, '--screenshot').map((path) => uploadScreenshot(path, stamp()))
  const labels = [AI_LABEL, ...all(args, '--label')]
  const sections = [bodyText(body as string)]
  if (images.length > 0) {
    sections.push(images.map((url) => `![screenshot](${url})`).join('\n\n'))
  }
  sections.push(`---\n\n*Found by an exploratory QA agent on ${headCommit(repoRoot)}.*`)

  const created = github(
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
  if (created.status !== 0) {
    throw new Error(`could not file the issue:\n${created.stderr.trim()}`)
  }
  console.log(created.stdout.trim())
}

/**
 * Shows on an issue that its fix works: a comment with what changed and the
 * screenshots that prove it.
 *
 *   qa evidence --issue 23 --body "The cmdline now floats…"
 *               --screenshot .grove-qa/shots/004-before.png
 *               --screenshot .grove-qa/shots/009-after.png
 */
function postEvidence(args: string[]): void {
  const form = 'evidence --issue <n> --body <file|text> [--screenshot …]'
  const issue = optional(args, '--issue')
  requireArgument(issue, form)
  const body = optional(args, '--body')
  requireArgument(body, form)

  const images = all(args, '--screenshot').map((path) => uploadScreenshot(path, stamp()))
  const sections = [bodyText(body as string)]
  if (images.length > 0) {
    sections.push(images.map((url) => `![screenshot](${url})`).join('\n\n'))
  }
  sections.push(`---\n\n*Verified by Claude on ${headCommit(process.cwd())}.*`)

  const commented = github(
    ['issue', 'comment', issue as string, '--repo', FINDINGS_REPO, '--body', sections.join('\n\n')],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (commented.status !== 0) {
    throw new Error(`could not comment on #${issue}:\n${commented.stderr.trim()}`)
  }
  console.log(commented.stdout.trim())
}

// -------------------------------------------------------------------- misc

/** Flags that take a value, so their values are not read as positional words. */
const VALUE_FLAGS = ['--screenshot', '--crop', '--nth', '--at', '--timeout', '--model']

/** The arguments that are not flags or flag values. */
function positional(args: string[]): string[] {
  const words: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (VALUE_FLAGS.includes(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('--')) {
      continue
    }
    words.push(argument)
  }
  return words
}

/** The value after a flag, when it was given. */
function optional(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) {
    return undefined
  }
  return args[index + 1]
}

/** Every value given for a flag that may be repeated, like `--label`. */
function all(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1]
    if (args[index] === flag && value !== undefined) {
      values.push(value)
    }
  }
  return values
}

function requireArgument(value: string | undefined, form: string): void {
  if (value === undefined || value.length === 0) {
    throw new Error(`usage: qa ${form}`)
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function usage(): void {
  console.log(`qa — drive Grove native the way a person does (bun run qa <command>)

  start [--fresh] [--build] [--no-daemon]
                              launch grove_native on a headless display of its
                              own, with its own profile and suite daemon. The
                              bundle is always rebuilt; --build also rebuilds
                              the Rust host; --fresh throws the profile away
  stop                        the app, everything it spawned, daemon and display
  restart [same flags]        stop, then start

Seeing:

  screenshot [label] [--crop x,y,w,h] [--again]
                              a PNG of the window; read it with the Read tool.
                              Refused when nothing has happened since the last
                              one, unless --again (the app changed by itself)
  probe [text]                is it up, its errors; with text, where it is
  wait <text> [--gone] [--timeout s]
                              until the text is on screen, or until it is not
  logs [n] [--errors]         the end of the app's log: host, UI and sidecar

Acting:

  click <target>              also dblclick, rightclick
  drag <from> <to>            press, move in steps, release
  type <text>                 into whatever has the keyboard
  press <chord> [chord …]     Escape, Control+s, Shift+Tab, g g
  scroll <pixels> [--at <target>]
                              negative is up

Every action takes --screenshot <label>, which photographs the result.

A target is the text on screen ("Problems"), found by reading a screenshot, with
--nth <n> when it is there more than once; or at=x,y, a point in the window, for
what shows no text: a divider, an icon, a spot in the editor.

  explore [scope] [--dry-run] [--model <model>]
                              hand the session to a Claude Code instance to test
  finding --title … --body … [--label …] [--screenshot …]
                              file what it found, screenshots attached
  evidence --issue <n> --body … [--screenshot …]
                              show on an issue that its fix works
  charters                    the charters that ship with the harness`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
