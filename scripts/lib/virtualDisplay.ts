// A display for a test run, that nobody is looking at.
//
// Every launch of grove opens a window, and windows opening and closing on the
// desktop the user is working on is unusable. The window cannot simply stay
// hidden: an unmapped window has a hidden document, Chromium stops
// requestAnimationFrame, and the editor's canvas never gets a frame — anything
// driving the editor then fails. So it needs a real display, somewhere else.
//
// Xvfb is the usual answer; Xvnc (tigervnc) serves as well, is more often
// already installed, and has the advantage that a human can attach a viewer and
// watch a run happen.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

export const GEOMETRY = { width: 1440, height: 900, depth: 24 }

/** The numbers reserved for test displays. The user's own is far below this. */
const DISPLAY_RANGE = { first: 90, last: 99 }

export interface VirtualDisplay {
  /** What to put in DISPLAY. */
  display: string
  /** The X server's process id. */
  pid: number
  /** Stop the server. Only meaningful for one this process started. */
  stop(): void
}

export interface DisplayOptions {
  /**
   * Keep the server running after this process exits.
   *
   * A suite runs start to finish in one process and takes its display down with
   * it; a session driven one command at a time outlives every process that
   * touches it, and has to tear the display down explicitly.
   */
  detached?: boolean
}

/** Bring up a virtual X display, or nothing if the host has no server for one. */
export async function startVirtualDisplay(
  options: DisplayOptions = {}
): Promise<VirtualDisplay | null> {
  reapAbandonedDisplays()

  const number = freeDisplayNumber()
  if (number === null) return null

  const display = `:${number}`
  const server = spawnDisplayServer(display, options.detached === true)
  if (!server) return null

  const ready = await waitForSocket(number)
  if (!ready) {
    server.kill('SIGKILL')
    return null
  }
  if (options.detached === true) server.unref()

  return {
    display,
    pid: server.pid ?? 0,
    stop: () => stopDisplay(number, server.pid ?? 0)
  }
}

/** Stop a display started earlier, by number, and clean up after it. */
export function stopVirtualDisplay(display: string, pid: number): void {
  const number = Number(display.replace(':', ''))
  if (!Number.isInteger(number)) return
  stopDisplay(number, pid)
}

function stopDisplay(number: number, pid: number): void {
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone, which is the outcome either way.
    }
  }
  removeDisplayFiles(number)
}

/**
 * Start whichever X server is available on this machine.
 *
 * Xvnc is told to accept no connections beyond the loopback interface: this is
 * a display for a test run, not a remote desktop.
 */
function spawnDisplayServer(display: string, detached: boolean): ChildProcess | null {
  const geometry = `${GEOMETRY.width}x${GEOMETRY.height}x${GEOMETRY.depth}`

  if (hasCommand('Xvfb')) {
    return spawnQuietly('Xvfb', [display, '-screen', '0', geometry, '-nolisten', 'tcp'], detached)
  }
  if (hasCommand('Xvnc')) {
    return spawnQuietly(
      'Xvnc',
      [
        display,
        '-geometry', `${GEOMETRY.width}x${GEOMETRY.height}`,
        '-depth', String(GEOMETRY.depth),
        '-SecurityTypes', 'None',
        '-localhost',
        '-AlwaysShared'
      ],
      detached
    )
  }
  return null
}

function spawnQuietly(command: string, args: string[], detached: boolean): ChildProcess {
  const child = spawn(command, args, { stdio: 'ignore', detached })
  child.on('error', () => {
    // Reported by the readiness check instead, which is what decides the outcome.
  })
  return child
}

export function hasCommand(command: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory && existsSync(`${directory}/${command}`)) return true
  }
  return false
}

/**
 * Remove the lock and socket of every display whose server has died.
 *
 * An X server deletes both on the way out, and does not get the chance when the
 * run holding it is killed. What it leaves behind still looks occupied, and
 * ten interrupted runs are enough to take the whole range — at which point the
 * next one has nowhere to start and no way to say why.
 */
export function reapAbandonedDisplays(): void {
  for (let number = DISPLAY_RANGE.first; number <= DISPLAY_RANGE.last; number += 1) {
    const owner = lockOwner(number)
    if (owner === null) continue
    if (isRunning(owner)) continue
    removeDisplayFiles(number)
  }
}

/** The pid written into a display's lock file, or null if there is no lock. */
function lockOwner(number: number): number | null {
  try {
    const contents = readFileSync(lockPath(number), 'utf8')
    const pid = Number(contents.trim())
    // A lock that cannot be read as a pid is not one to act on.
    if (!Number.isInteger(pid) || pid <= 0) return null
    return pid
  } catch {
    return null
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function removeDisplayFiles(number: number): void {
  rmSync(lockPath(number), { force: true })
  rmSync(socketPath(number), { force: true })
}

/** The first display number nothing else has claimed. */
function freeDisplayNumber(): number | null {
  for (let number = DISPLAY_RANGE.first; number <= DISPLAY_RANGE.last; number += 1) {
    if (!existsSync(socketPath(number)) && !existsSync(lockPath(number))) return number
  }
  return null
}

/** Wait for the server to publish its socket, which is when clients can connect. */
async function waitForSocket(number: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socketPath(number))) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function socketPath(number: number): string {
  return `/tmp/.X11-unix/X${number}`
}

function lockPath(number: number): string {
  return `/tmp/.X${number}-lock`
}

/**
 * The environment a child needs to land on `display` rather than the desktop.
 *
 * Electron picks Wayland on a Wayland session and ignores DISPLAY entirely, so
 * the hint and the socket both have to go: the hint decides, and `auto` follows
 * the socket.
 */
export function displayEnv(display: string): Record<string, string> {
  return {
    DISPLAY: display,
    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
    XDG_SESSION_TYPE: 'x11'
  }
}
