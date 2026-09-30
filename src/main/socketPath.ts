// Where a profile's local sockets live. A unix socket's path has to fit in
// sun_path, so a profile deep in the filesystem (a worktree's QA profile) gets
// its sockets in a short per-profile directory instead of under userData.
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

// sun_path is 108 bytes on Linux and 104 on macOS, the terminating NUL included.
const MAX_SOCKET_PATH_BYTES = 103

/**
 * Resolves the socket named `name` for the profile at `userData`: `preferred`
 * when it fits sun_path, otherwise the same name in a directory under the
 * runtime dir keyed by a hash of the profile, so it stays stable across runs.
 */
export function profileSocketPath(
  userData: string,
  preferred: string,
  name: string,
  runtimeDirectory: string = defaultRuntimeDirectory()
): string {
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) {
    return preferred
  }
  return join(runtimeDirectory, `grove-${profileHash(userData)}`, name)
}

/** A short, stable name for the profile at `userData`. */
export function profileHash(userData: string): string {
  return createHash('sha256').update(userData).digest('hex').slice(0, 12)
}

/** The per-user runtime dir when the session has one, the tmp dir otherwise. */
function defaultRuntimeDirectory(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR
  if (runtimeDirectory) {
    return runtimeDirectory
  }
  return tmpdir()
}
