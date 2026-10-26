// The display a QA session's app draws on: a headless gamescope, nobody's desktop.
//
// Grove native is a GPUI window, and GPUI presents through Vulkan. A plain X
// server such as Xvfb or Xvnc has no DRI3, so Vulkan cannot present to it and the
// window stays black. gamescope's headless backend runs its own Xwayland on the
// GPU instead: windows on it render for real, `import` can read them back, and
// `xdotool` drives them through XTEST. It never opens a window on the user's
// desktop and never touches the compositor they are working in.
//
// gamescope lives exactly as long as the program it was started with, so it is
// started with a keeper: a shell that writes the display's name to a file and then
// sleeps. The app is launched separately, onto that display, and can be restarted
// without taking the display down.

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The size of the headless output, and of the app's window on it. */
export const SCREEN = { width: 1440, height: 900 }

/** How long gamescope gets to bring its Xwayland up. */
const DISPLAY_TIMEOUT_MS = 15_000

export interface HeadlessDisplay {
  /** What to put in DISPLAY, such as `:2`. */
  display: string
  /** gamescope's process id, which leads the process group the display lives in. */
  pid: number
}

/** Whether this machine has what a headless display needs. */
export function missingDisplayTools(): string[] {
  const needed = ['gamescope', 'xdotool', 'import']
  return needed.filter((command) => !hasCommand(command))
}

/**
 * Start a headless gamescope and wait for its Xwayland, in a process group of its
 * own, so the session outlives the command that started it.
 */
export async function startHeadlessDisplay(directory: string, logPath: string): Promise<HeadlessDisplay> {
  const keeper = join(directory, 'display-keeper.sh')
  const nameFile = join(directory, 'display-name')
  rmSync(nameFile, { force: true })
  writeFileSync(keeper, '#!/bin/sh\necho "$DISPLAY" > "$1"\nexec sleep infinity\n')
  chmodSync(keeper, 0o755)

  const arguments_ = [
    '--backend', 'headless',
    '-W', String(SCREEN.width), '-H', String(SCREEN.height),
    '-w', String(SCREEN.width), '-h', String(SCREEN.height),
    '--', keeper, nameFile
  ]
  writeFileSync(logPath, '')
  const child = spawn('gamescope', arguments_, {
    detached: true,
    stdio: ['ignore', openAppend(logPath), openAppend(logPath)],
    env: displayServerEnvironment()
  })
  child.unref()
  const pid = child.pid
  if (pid === undefined) {
    throw new Error('gamescope did not start')
  }

  const display = await waitForDisplayName(nameFile)
  if (display === null) {
    stopHeadlessDisplay(pid)
    throw new Error(`gamescope did not bring a display up within ${DISPLAY_TIMEOUT_MS / 1000}s — see ${logPath}`)
  }
  return { display, pid }
}

/** Stop a display and everything still running in its process group. */
export function stopHeadlessDisplay(pid: number): void {
  killGroup(pid)
}

/** Whether the display's gamescope is still running. */
export function displayIsRunning(pid: number): boolean {
  return processIsRunning(pid)
}

/**
 * The environment gamescope starts in: the user's, without the Wayland and X
 * sessions it would otherwise attach to as a nested window.
 */
function displayServerEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue
    }
    environment[name] = value
  }
  delete environment.WAYLAND_DISPLAY
  delete environment.DISPLAY
  return environment
}

/** Polls for the name the keeper writes once gamescope's Xwayland is up. */
async function waitForDisplayName(nameFile: string): Promise<string | null> {
  const deadline = Date.now() + DISPLAY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(nameFile)) {
      const name = readFileSync(nameFile, 'utf8').trim()
      if (name.length > 0) {
        return name
      }
    }
    await Bun.sleep(100)
  }
  return null
}

/** A file descriptor appending to a log, for a detached child's output. */
export function openAppend(path: string): number {
  return openSync(path, 'a')
}

/** Sends SIGTERM to a process group, then SIGKILL to whatever is left a moment later. */
export function killGroup(pid: number): void {
  if (pid <= 0) {
    return
  }
  signalGroup(pid, 'SIGTERM')
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && processIsRunning(pid)) {
    Bun.sleepSync(50)
  }
  signalGroup(pid, 'SIGKILL')
}

/** Signals a process group, and the process itself when it leads none. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // Not a group leader, or already gone.
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone, which is the outcome either way.
  }
}

/** Whether a process exists and is not a zombie. */
export function processIsRunning(pid: number): boolean {
  if (pid <= 0) {
    return false
  }
  const status = `/proc/${pid}/stat`
  if (!existsSync(status)) {
    return false
  }
  const fields = readFileSync(status, 'utf8').split(') ')
  if (fields.length < 2) {
    return false
  }
  return !fields[1].startsWith('Z')
}

/** Whether a command is on PATH. */
export function hasCommand(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}
