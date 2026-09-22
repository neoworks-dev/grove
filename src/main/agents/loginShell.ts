// The shell the composer's `!` commands run in: the user's own login shell, so
// a command behaves exactly as it would in their terminal.
//
// The account's passwd entry is asked first. `$SHELL` is only inherited from
// whatever launched the app — an editor's terminal, a tool that sets its own —
// so it can name a shell the user does not actually use. /bin/sh stands in
// when neither points at anything.

import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, isAbsolute } from 'node:path'

const FALLBACK_SHELL = '/bin/sh'

export interface LoginShell {
  /** Absolute path to the executable. */
  path: string
  /** Its name, e.g. `fish` or `bash`, which decides completion and highlighting. */
  name: string
}

/** Resolves the user's login shell: passwd, then `$SHELL`, then /bin/sh. */
export function resolveLoginShell(
  environment: NodeJS.ProcessEnv = process.env,
  accountShell: string | null = passwdShell()
): LoginShell {
  for (const candidate of [accountShell, environment.SHELL]) {
    if (isUsableShell(candidate)) {
      return { path: candidate, name: basename(candidate) }
    }
  }
  return { path: FALLBACK_SHELL, name: basename(FALLBACK_SHELL) }
}

/** The shell in the account's passwd entry, or null where there is none (Windows). */
function passwdShell(): string | null {
  try {
    return userInfo().shell
  } catch {
    return null
  }
}

/** Whether a path names an executable that exists. */
function isUsableShell(candidate: string | null | undefined): candidate is string {
  if (!candidate || !isAbsolute(candidate)) {
    return false
  }
  return existsSync(candidate)
}
