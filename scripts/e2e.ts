#!/usr/bin/env bun
// Run the end-to-end suite on a display of its own.
//
// The display itself is `scripts/lib/virtualDisplay.ts`, which explains why one
// is needed. It is created here, torn down after, and never advertised to the
// session's compositor. Without one the suite still runs, on the desktop, with
// a warning.

import { spawn } from 'node:child_process'
import { displayEnv, startVirtualDisplay, type VirtualDisplay } from './lib/virtualDisplay'

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
    const code = await runPlaywright(playwrightArgs, virtual)
    process.exit(code)
  } finally {
    virtual?.stop()
  }
}

/** Run the suite, pointed at `virtual` when there is one. */
function runPlaywright(args: string[], virtual: VirtualDisplay | null): Promise<number> {
  const env = { ...process.env }
  if (virtual) {
    Object.assign(env, displayEnv(virtual.display))
    delete env.WAYLAND_DISPLAY
  }

  const child = spawn('bunx', ['playwright', 'test', ...args], { stdio: 'inherit', env })
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

await main()
