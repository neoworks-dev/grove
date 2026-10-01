// Prompt blame shared through git notes.
//
// Prompt blame's own records live on this machine. To let a teammate see the
// prompt behind a line, the records that explain a commit are written as a
// note on it, under a ref of Grove's own so `git log` stays as it was. Notes
// are one JSON record per line: merging a teammate's notes with
// `cat_sort_uniq` then never conflicts, it just keeps every distinct record.

import { simpleGit } from 'simple-git'

export const PROMPT_NOTES_REF = 'refs/notes/grove-prompts'

// Where a remote's notes land before they are merged into ours.
const INCOMING_NOTES_REF = 'refs/notes/grove-prompts-incoming'

// A push annotates at most this many commits, so a branch that has never
// been pushed does not stall on its whole history.
const MAX_UNPUBLISHED_COMMITS = 500

/** The lines of a commit's prompt note, or none when it has no note. */
export async function readNote(worktreePath: string, sha: string): Promise<string[]> {
  try {
    const output = await simpleGit({ baseDir: worktreePath }).raw([
      'notes',
      `--ref=${PROMPT_NOTES_REF}`,
      'show',
      sha
    ])
    return output.split('\n').filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

/** Puts a prompt note on a commit, replacing any it had. */
export async function writeNote(worktreePath: string, sha: string, lines: string[]): Promise<void> {
  await simpleGit({ baseDir: worktreePath }).raw([
    'notes',
    `--ref=${PROMPT_NOTES_REF}`,
    'add',
    '--force',
    '--message',
    lines.join('\n'),
    sha
  ])
}

/** Commits on HEAD that no remote-tracking branch has yet: the ones a push publishes. */
export async function unpublishedCommits(worktreePath: string): Promise<string[]> {
  const output = await simpleGit({ baseDir: worktreePath }).raw([
    'rev-list',
    `--max-count=${MAX_UNPUBLISHED_COMMITS}`,
    'HEAD',
    '--not',
    '--remotes'
  ])
  return output.split('\n').filter((line) => line.length > 0)
}

/**
 * Merges a remote's prompt notes into ours. A remote nobody has shared notes
 * to yet has no such ref, which is not an error.
 */
export async function fetchNotes(worktreePath: string, remote: string): Promise<void> {
  const git = simpleGit({ baseDir: worktreePath })
  try {
    await git.raw(['fetch', remote, `+${PROMPT_NOTES_REF}:${INCOMING_NOTES_REF}`])
  } catch (error) {
    if ((error as Error).message.includes("couldn't find remote ref")) return
    throw error
  }
  await git.raw([
    'notes',
    `--ref=${PROMPT_NOTES_REF}`,
    'merge',
    '--quiet',
    '--strategy=cat_sort_uniq',
    INCOMING_NOTES_REF
  ])
  await git.raw(['update-ref', '-d', INCOMING_NOTES_REF])
}

/** Pushes our prompt notes to a remote, merging in whatever it already has first. */
export async function pushNotes(worktreePath: string, remote: string): Promise<void> {
  if (!(await hasLocalNotes(worktreePath))) return
  await fetchNotes(worktreePath, remote)
  await simpleGit({ baseDir: worktreePath }).raw([
    'push',
    remote,
    `${PROMPT_NOTES_REF}:${PROMPT_NOTES_REF}`
  ])
}

/** Whether this repository has written or fetched any prompt notes. */
async function hasLocalNotes(worktreePath: string): Promise<boolean> {
  const output = await simpleGit({ baseDir: worktreePath }).raw(['for-each-ref', PROMPT_NOTES_REF])
  return output.trim().length > 0
}

/** A git summary with any prompt-notes problems on lines after it. */
export function withProblems(summary: string, problems: string[]): string {
  const reported = problems.filter((problem) => problem.length > 0)
  if (reported.length === 0) return summary
  return [summary, ...reported].join('\n')
}
