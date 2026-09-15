// What the working bar says while a turn is in flight.
//
// The bar cannot say anything true about what the model is doing — the tool
// calls already do that, further up. So it says something else: a line that
// makes the wait feel like someone is in there working.

export const WORKING_PHRASES = [
  'Bribing the compiler',
  'Negotiating with the type checker',
  'Untangling the dependency graph',
  'Consulting the rubber duck',
  'Reticulating splines',
  'Sharpening the semicolons',
  'Waking the linter',
  'Herding the worktrees',
  'Convincing git it is fine',
  'Rewriting history, carefully',
  'Warming up a regex',
  'Asking nvim nicely',
  'Blaming the cache',
  'Reading the stack trace out loud',
  'Overthinking a variable name',
  'Bisecting the vibes',
  'Poking the daemon',
  'Grepping for meaning',
  'Aligning the braces',
  'Pretending to have read the docs',
  'Arguing with a linter rule',
  'Feeding the merge conflict',
  'Counting tokens on its fingers',
  'Refactoring in the dark',
  'Looking busy, thinking hard',
  'Teaching the parser manners',
  'Defragmenting an opinion',
  'Checking if it compiles in its head'
]

/**
 * A phrase to show next, never the one already on screen.
 *
 * Pass the phrase currently showing (or an empty string on first draw); the
 * result is drawn from everything else, so a rotation never stutters by landing
 * on the same line twice.
 */
export function nextWorkingPhrase(current: string): string {
  const choices = WORKING_PHRASES.filter((phrase) => phrase !== current)
  const index = Math.floor(Math.random() * choices.length)
  return choices[index]
}
