// Completion for the composer's `!` commands, answered by the shell they run in.
//
// Under fish that is fish's own completer, which knows subcommands and options
// with their descriptions — from its bundled completions and from man pages it
// has parsed. Any other shell gets bash's `compgen`: commands for the first
// word, paths after it. Either way there is no list of commands to keep up to
// date here, and the line being completed goes in as a positional argument,
// never into the script text, so nothing typed in the draft is ever run.

import { execFile, spawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShellCompletion } from '../../shared/agents'
import type { LoginShell } from './loginShell'

export interface ShellCompletionOptions {
  /**
   * Where grove keeps man-page completions it generated for fish itself. It
   * must be named `generated_completions`: fish ranks its bundled completions
   * above a directory of that name only, and a man-page `git.fish` elsewhere
   * on the path would shadow the real one.
   */
  fishCompletionsDir?: string
  limit?: number
}

const COMPLETION_TIMEOUT_MS = 2_000
const DEFAULT_LIMIT = 50

// Man-page completions are regenerated when older than this.
const MANPAGE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000

// fish: grove's generated man-page completions go last on the search path, so
// the user's own and fish's bundled ones win.
const FISH_SCRIPT = `if test -n "$argv[2]"
  set -a fish_complete_path $argv[2]
end
complete --do-complete=$argv[1]`

// bash: everything bash could run under that name.
const BASH_COMMAND_SCRIPT = 'compgen -c -- "$1"'

// bash: paths, with a trailing slash on directories so the next completion descends.
const BASH_PATH_SCRIPT = `compgen -f -- "$1" | while IFS= read -r entry; do
  if [ -d "$entry" ]; then printf '%s/\\n' "$entry"; else printf '%s\\n' "$entry"; fi
done`

// Touched after each generation; its age is how old the set is.
const GENERATED_STAMP = '.grove-generated'

// Generates fish completions from man pages with the script fish ships, into a
// directory of grove's rather than the user's own.
const MANPAGE_SCRIPT = `fish -c 'status get-file tools/create_manpage_completions.py' |
  python3 -B - --manpath --directory="$1"`

/**
 * What the shell would offer for the last word of `line`, run in `cwd`.
 * `line` is the command as typed up to the caret.
 */
export async function completeShellLine(
  line: string,
  shell: LoginShell,
  cwd: string,
  options: ShellCompletionOptions = {}
): Promise<ShellCompletion[]> {
  let limit = DEFAULT_LIMIT
  if (options.limit !== undefined) {
    limit = options.limit
  }
  if (shell.name === 'fish') {
    return completeWithFish(line, cwd, options.fishCompletionsDir, limit)
  }
  return completeWithBash(line, cwd, limit)
}

/** fish's own completer, descriptions included. */
async function completeWithFish(
  line: string,
  cwd: string,
  completionsDir: string | undefined,
  limit: number
): Promise<ShellCompletion[]> {
  let extraPath = ''
  if (completionsDir) {
    ensureManpageCompletions(completionsDir)
    extraPath = completionsDir
  }
  const output = await run('fish', ['-c', FISH_SCRIPT, '--', line, extraPath], cwd)
  return parseFishCompletions(output).slice(0, limit)
}

/** One completion per line, `value<TAB>description`, deduplicated in fish's order. */
export function parseFishCompletions(output: string): ShellCompletion[] {
  const seen = new Set<string>()
  const completions: ShellCompletion[] = []
  for (const line of output.split('\n')) {
    const [value, description] = line.split('\t')
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    completions.push(withDescription(value, description))
  }
  return completions
}

/** A completion, leaving the description off when the shell gave none. */
function withDescription(value: string, description: string | undefined): ShellCompletion {
  if (!description) {
    return { value }
  }
  return { value, description }
}

/** bash's `compgen`: the first word as a command, any later one as a path. */
async function completeWithBash(line: string, cwd: string, limit: number): Promise<ShellCompletion[]> {
  const word = lastWord(line)
  let script = BASH_PATH_SCRIPT
  if (line.slice(0, line.length - word.length).trim().length === 0) {
    script = BASH_COMMAND_SCRIPT
  }
  const output = await run('bash', ['-c', script, 'grove-complete', word], cwd)
  return rankCandidates(output, limit).map((value) => ({ value }))
}

/** The word the caret ends: everything after the last whitespace. */
export function lastWord(line: string): string {
  const match = /\S*$/.exec(line)
  if (!match) {
    return ''
  }
  return match[0]
}

/** Unique, non-empty lines, shortest first and then alphabetical. */
export function rankCandidates(output: string, limit: number): string[] {
  const unique = new Set(output.split('\n').filter((line) => line.length > 0))
  return [...unique]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, limit)
}

/** Runs a program and returns what it printed; a failure completes to nothing. */
function run(program: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
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

let manpageGeneration: Promise<void> | null = null

/**
 * Generates fish's man-page completions into `directory` in the background,
 * once per run, when there are none yet or they have gone stale. Completion
 * does not wait for it: the first few calls just go without them.
 */
function ensureManpageCompletions(directory: string): void {
  if (manpageGeneration) {
    return
  }
  manpageGeneration = generateIfStale(directory).catch(() => undefined)
}

/** Runs the man-page generator unless `directory` already holds a fresh set. */
async function generateIfStale(directory: string): Promise<void> {
  if (await isFresh(directory)) {
    return
  }
  await mkdir(directory, { recursive: true })
  await new Promise<void>((resolve) => {
    const child = spawn('sh', ['-c', MANPAGE_SCRIPT, 'grove-manpages', directory], {
      stdio: 'ignore'
    })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
  await writeFile(join(directory, GENERATED_STAMP), '')
}

/** Whether `directory` was generated within the refresh interval. */
async function isFresh(directory: string): Promise<boolean> {
  try {
    const info = await stat(join(directory, GENERATED_STAMP))
    return Date.now() - info.mtimeMs < MANPAGE_REFRESH_MS
  } catch {
    return false
  }
}
