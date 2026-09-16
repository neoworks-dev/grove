#!/usr/bin/env bun
// Run the end-to-end suite on a display of its own.
//
// Every test launches a window, and two dozen windows opening and closing on
// the desktop the user is working on is unusable. The window cannot simply stay
// hidden: an unmapped window has a hidden document, Chromium stops
// requestAnimationFrame, and the editor's canvas never gets a frame — the
// suite's editing tests fail. So it needs a real display that nobody is
// looking at.
//
// Xvfb is the usual answer; Xvnc (tigervnc) serves as well and is more often
// already installed. Either way the display is created here, torn down after,
// and never advertised to the session's compositor. Without one the suite still
// runs, on the desktop, with a warning.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

const GEOMETRY = { width: 1440, height: 900, depth: 24 }

interface VirtualDisplay {
  display: string
  server: ChildProcess
}

async function main(): Promise<void> {
  const playwrightArgs = process.argv.slice(2)
  const virtual = await startVirtualDisplay()

  if (!virtual) {
    console.warn(
      'e2e: no Xvfb or Xvnc found — the suite will open windows on your desktop.\n' +
        '     install one to keep them out of the way: sudo pacman -S xorg-server-xvfb'
    )
  }

  try {
    const code = await runPlaywright(playwrightArgs, virtual?.display)
    process.exit(code)
  } finally {
    virtual?.server.kill('SIGTERM')
  }
}

/** Run the suite, pointed at `display` when there is one. */
function runPlaywright(args: string[], display?: string): Promise<number> {
  const env = { ...process.env }
  if (display) {
    env.DISPLAY = display
    // The virtual display is an X server, and Electron picks Wayland on a
    // Wayland session — it would land back on the user's compositor and ignore
    // DISPLAY. Both the hint and the socket have to go: the hint decides, and
    // `auto` follows the socket.
    env.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
    env.XDG_SESSION_TYPE = 'x11'
    delete env.WAYLAND_DISPLAY
  }

  const child = spawn('bunx', ['playwright', 'test', ...args], { stdio: 'inherit', env })
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

/** Bring up a virtual X display, or nothing if the host has no server for one. */
async function startVirtualDisplay(): Promise<VirtualDisplay | null> {
  const number = freeDisplayNumber()
  if (number === null) return null

  const display = `:${number}`
  const server = spawnDisplayServer(display)
  if (!server) return null

  const ready = await waitForSocket(number)
  if (!ready) {
    server.kill('SIGKILL')
    return null
  }
  return { display, server }
}

/**
 * Start whichever X server is available on this machine.
 *
 * Xvnc is told to accept no connections beyond the loopback interface: this is
 * a display for a test run, not a remote desktop.
 */
function spawnDisplayServer(display: string): ChildProcess | null {
  const geometry = `${GEOMETRY.width}x${GEOMETRY.height}x${GEOMETRY.depth}`

  if (hasCommand('Xvfb')) {
    return detached('Xvfb', [display, '-screen', '0', geometry, '-nolisten', 'tcp'])
  }
  if (hasCommand('Xvnc')) {
    return detached('Xvnc', [
      display,
      '-geometry', `${GEOMETRY.width}x${GEOMETRY.height}`,
      '-depth', String(GEOMETRY.depth),
      '-SecurityTypes', 'None',
      '-localhost',
      '-AlwaysShared'
    ])
  }
  return null
}

function detached(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: 'ignore' })
  child.on('error', () => {
    // Reported by the readiness check below, which is what decides the outcome.
  })
  return child
}

function hasCommand(command: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory && existsSync(`${directory}/${command}`)) return true
  }
  return false
}

/** The first display number nothing else has claimed. */
function freeDisplayNumber(): number | null {
  for (let number = 90; number < 100; number += 1) {
    if (!existsSync(socketPath(number))) return number
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

await main()
