// `@` file mentions in the composer: the word at the cursor starting with `@` opens a list of the
// session's files to put there. `@` alone lists the session's directory, `@src/` a folder in it,
// and anything after the last `/` is matched loosely against every file and folder under that
// directory (`@ap` finds `src/app.rs`). Picking a folder keeps the list open in it; picking a file
// ends the word. Plain functions, so they are tested without a window. Ported from neo term
// (apps/term mention.rs); files above the session's directory are not offered.

/** The `@word` the cursor is in: where its `@` is, and what follows it up to the cursor. */
export interface Mention {
  start: number;
  query: string;
}

/** One thing to put after the `@`: its path relative to the session's directory, a folder's ending in `/`. */
export interface Candidate {
  path: string;
  dir: boolean;
}

/** Matches offered at most. */
export const MAX_MATCHES = 50;

/** The `@word` ending at `cursor` (a UTF-16 offset), when its `@` starts a word. */
export function mentionAt(text: string, cursor: number): Mention | undefined {
  const before = text.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  const word = before.slice(start);
  if (!word.startsWith("@")) {
    return undefined;
  }
  const query = word.slice(1);
  // An e-mail address or a second `@` is not a mention.
  if (query.includes("@")) {
    return undefined;
  }
  return { start, query };
}

/** What `accept` makes of the text: the `@word` replaced by the picked path, and where the cursor goes. */
export function accept(text: string, cursor: number, mention: Mention, pick: Candidate): { text: string; cursor: number } {
  let word = `@${pick.path}`;
  if (!pick.dir) {
    word += " ";
  }
  const next = text.slice(0, mention.start) + word + text.slice(cursor);
  return { text: next, cursor: mention.start + word.length };
}

/** Every file and every folder above one, folders ending in `/`, from the files ripgrep lists. */
export function entriesOf(files: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    let at = file.indexOf("/");
    while (at >= 0) {
      folders.add(file.slice(0, at + 1));
      at = file.indexOf("/", at + 1);
    }
  }
  return [...folders, ...files];
}

/** The query split into the folder it is in (as typed, ending in `/` unless empty) and what to match there. */
function split(query: string): { directory: string; name: string } {
  const at = query.lastIndexOf("/");
  if (at < 0) {
    return { directory: "", name: query };
  }
  return { directory: query.slice(0, at + 1), name: query.slice(at + 1) };
}

/**
 * How well `path` matches `query` (case does not matter), undefined when it does not: the name
 * holding it whole first, then the path holding it, then its letters in order; shorter paths first
 * among equals.
 */
export function score(path: string, query: string): number | undefined {
  const lowerPath = path.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const trimmed = lowerPath.replace(/\/$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const length = path.length;
  if (name.startsWith(lowerQuery)) {
    return 40_000 - length;
  }
  if (name.includes(lowerQuery)) {
    return 30_000 - length;
  }
  if (lowerPath.includes(lowerQuery)) {
    return 20_000 - length;
  }
  // In order, with the gaps between them counted against it.
  let gaps = 0;
  let from = 0;
  for (const letter of lowerQuery) {
    const found = lowerPath.indexOf(letter, from);
    if (found < 0) {
      return undefined;
    }
    gaps += found - from;
    from = found + 1;
  }
  return 10_000 - gaps * 10 - length;
}

/** What to offer for a query, from the entries of the session's directory. Nothing for a path that leaves it. */
export function candidatesFor(entries: readonly string[], query: string): Candidate[] {
  if (query.startsWith("..") || query.startsWith("/") || query.startsWith("~")) {
    return [];
  }
  const { directory, name } = split(query);
  const inside = entries.filter((entry) => entry.startsWith(directory) && entry !== directory);
  if (name === "") {
    return inside
      .filter((entry) => !entry.slice(directory.length).replace(/\/$/, "").includes("/"))
      .sort(foldersFirst)
      .slice(0, MAX_MATCHES)
      .map(asCandidate);
  }
  const scored: { entry: string; value: number }[] = [];
  for (const entry of inside) {
    const value = score(entry.slice(directory.length), name);
    if (value !== undefined) {
      scored.push({ entry, value });
    }
  }
  scored.sort((first, second) => second.value - first.value || first.entry.localeCompare(second.entry));
  return scored.slice(0, MAX_MATCHES).map((match) => asCandidate(match.entry));
}

/** Folders before files, then by name. */
function foldersFirst(first: string, second: string): number {
  const firstIsFolder = first.endsWith("/");
  const secondIsFolder = second.endsWith("/");
  if (firstIsFolder !== secondIsFolder) {
    if (firstIsFolder) {
      return -1;
    }
    return 1;
  }
  return first.localeCompare(second);
}

/** A list entry as a candidate. */
function asCandidate(entry: string): Candidate {
  return { path: entry, dir: entry.endsWith("/") };
}
