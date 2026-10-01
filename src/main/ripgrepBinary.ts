// The ripgrep binary to spawn. In the packaged app `@vscode/ripgrep` resolves
// it inside app.asar, which is a file: Electron reads from it but cannot exec
// from it, so spawning that path fails with ENOTDIR. electron-builder unpacks
// the binary beside the archive (asarUnpack), and that copy is the one to run.

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
