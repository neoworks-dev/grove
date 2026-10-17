// What the working bar says while a turn is in flight. It cannot say anything true about what the
// model is doing, since the tool calls above it already do that, so it says something else: a
// line that makes the wait feel like someone is in there. The same lines as Grove's original pane.

export const WORKING_PHRASES = [
  "Bribing the compiler",
  "Negotiating with the type checker",
  "Untangling the dependency graph",
  "Consulting the rubber duck",
  "Reticulating splines",
  "Sharpening the semicolons",
  "Waking the linter",
  "Herding the worktrees",
  "Convincing git it is fine",
  "Rewriting history, carefully",
  "Warming up a regex",
  "Asking nvim nicely",
  "Blaming the cache",
  "Reading the stack trace out loud",
  "Overthinking a variable name",
  "Bisecting the vibes",
  "Poking the daemon",
  "Grepping for meaning",
  "Aligning the braces",
  "Pretending to have read the docs",
  "Arguing with a linter rule",
  "Feeding the merge conflict",
  "Counting tokens on its fingers",
  "Refactoring in the dark",
  "Looking busy, thinking hard",
  "Teaching the parser manners",
  "Defragmenting an opinion",
  "Checking if it compiles in its head",
];

/** A phrase to show next, never the one already on screen; `random` is in [0, 1). */
export function nextWorkingPhrase(current: string, random: number = Math.random()): string {
  const choices = WORKING_PHRASES.filter((phrase) => phrase !== current);
  return choices[Math.floor(random * choices.length)];
}

/** `32.0k` for thousands, the plain number below; undefined when the count is not known. */
export function tokensLabel(count: number | undefined): string | undefined {
  if (count === undefined) {
    return undefined;
  }
  if (count < 1000) {
    return String(count);
  }
  return `${(count / 1000).toFixed(1)}k`;
}
