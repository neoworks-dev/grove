// Running the ripgrep grove ships. In the packaged app `@vscode/ripgrep` resolves
// it inside app.asar, which is a file: Electron reads from it but cannot exec
// from it, so spawning that path fails with ENOTDIR. electron-builder unpacks
// the binary beside the archive (asarUnpack), and that copy is the one to run.

import { spawn } from 'child_process'
import { sep } from 'path'
import { rgPath } from '@vscode/ripgrep'

const PACKED = `${sep}app.asar${sep}`
const UNPACKED = `${sep}app.asar.unpacked${sep}`

/** Maps a path inside app.asar to its unpacked copy; any other path is returned as is. */
export function unpackedPath(path: string): string {
  return path.replace(PACKED, UNPACKED)
}

/** Absolute path of a ripgrep binary that can be spawned, packaged or not. */
export const ripgrepBinary = unpackedPath(rgPath)

export interface RipgrepOutput {
  lines: string[]
  /** ripgrep exits 1 for "nothing found" and 2 for errors, even beside matches. */
  failed: boolean
  error: string
}

/**
 * Run ripgrep over a file or directory and collect what it prints. The target
 * is passed absolute, so every path it prints is too.
 */
export function ripgrep(cwd: string, target: string, args: string[]): Promise<RipgrepOutput> {
  return new Promise((resolve) => {
    const child = spawn(ripgrepBinary, [...args, '--', target], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (cause) => resolve({ lines: [], failed: true, error: cause.message }))
    child.on('close', (code) => {
      const lines = stdout.split('\n')
      const failed = code === 2 && stdout.trim().length === 0
      resolve({ lines, failed, error: stderr.trim() })
    })
  })
}
