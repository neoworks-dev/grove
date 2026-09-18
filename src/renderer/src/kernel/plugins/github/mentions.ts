// Finding the @mention the caret is sitting in, and completing it.
//
// Kept away from the component so the rules are testable: a mention only starts
// where a word can start, it ends at the first character a GitHub login cannot
// contain, and an address the user has already finished typing is not a
// half-written one to keep offering suggestions for.

export interface MentionQuery {
  /** Index of the `@`. */
  start: number
  /** What has been typed after it, which may be empty. */
  query: string
}

/** GitHub logins are alphanumerics and hyphens; nothing else continues one. */
function isLoginCharacter(character: string): boolean {
  return /[A-Za-z0-9-]/.test(character)
}

/**
 * An `@` only opens a mention at the start of a word — mid-word it is an email
 * address or a handle already written out, not something to complete.
 */
function opensMention(text: string, at: number): boolean {
  if (at === 0) return true
  return /\s|\(|\[/.test(text[at - 1])
}

/** The mention the caret is inside, or null when it is not in one. */
export function activeMention(text: string, caret: number): MentionQuery | null {
  let index = caret - 1
  while (index >= 0) {
    const character = text[index]
    if (character === '@') {
      if (!opensMention(text, index)) return null
      return { start: index, query: text.slice(index + 1, caret) }
    }
    if (!isLoginCharacter(character)) return null
    index -= 1
  }
  return null
}

/** The text and caret after accepting a suggestion for this mention. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  login: string
): { text: string; caret: number } {
  // Replace through whatever of the login was already typed, not just to the
  // caret — completing in the middle of a half-typed name must not leave its
  // tail behind.
  let end = mention.start + 1 + mention.query.length
  while (end < text.length && isLoginCharacter(text[end])) end += 1
  const completed = `@${login} `
  return {
    text: text.slice(0, mention.start) + completed + text.slice(end),
    caret: mention.start + completed.length
  }
}

/**
 * Logins to offer for a query, best first: the ones that start with what was
 * typed, then the ones that merely contain it. Case-insensitive, because
 * GitHub logins are.
 */
export function rankMentions(logins: string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) return logins.slice(0, limit)
  const prefixed: string[] = []
  const contained: string[] = []
  for (const login of logins) {
    const haystack = login.toLowerCase()
    if (haystack.startsWith(needle)) {
      prefixed.push(login)
      continue
    }
    if (haystack.includes(needle)) contained.push(login)
  }
  return [...prefixed, ...contained].slice(0, limit)
}
