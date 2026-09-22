// Completion for the composer's `!` commands, answered by bash itself.
//
// `compgen` knows what the user's shell would offer — every executable on PATH,
// builtins, and paths relative to the directory the command will run in — so
// there is no list of commands to keep up to date here. The word being
// completed goes in as a positional argument, never into the script text, so
// nothing typed in the draft is ever run.

import { execFile } from 'node:child_process'

/** Which word of the command line is being completed. */
export type ShellWordPosition = 'command' | 'argument'

const COMPLETION_TIMEOUT_MS = 2_000
const DEFAULT_LIMIT = 20

// Commands: everything bash could run under that name.
const COMMAND_SCRIPT = 'compgen -c -- "$1"'

// Paths, with a trailing slash on directories so the next completion descends.
const PATH_SCRIPT = `compgen -f -- "$1" | while IFS= read -r entry; do
  if [ -d "$entry" ]; then printf '%s/\\n' "$entry"; else printf '%s\\n' "$entry"; fi
done`

/**
 * What bash would complete `word` to, run in `cwd`: commands for the first word
 * of the line, paths for the ones after it. Shortest first, so the name typed
 * so far outranks everything that merely starts with it.
 */
export async function completeShellWord(
  word: string,
  position: ShellWordPosition,
  cwd: string,
  limit = DEFAULT_LIMIT
): Promise<string[]> {
  let script = PATH_SCRIPT
  if (position === 'command') {
    script = COMMAND_SCRIPT
  }
  const output = await runBash(script, word, cwd)
  return rankCandidates(output, limit)
}

/** Unique, non-empty lines, shortest first and then alphabetical. */
export function rankCandidates(output: string, limit: number): string[] {
  const unique = new Set(output.split('\n').filter((line) => line.length > 0))
  return [...unique]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, limit)
}

/** Runs a bash script with one positional argument; a failure completes to nothing. */
function runBash(script: string, argument: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', script, 'grove-complete', argument],
      { cwd, timeout: COMPLETION_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          resolve('')
          return
        }
        resolve(stdout)
      }
    )
  })
}
