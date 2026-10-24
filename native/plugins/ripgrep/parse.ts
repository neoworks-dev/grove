// What the ripgrep service asks ripgrep and how it reads the answer. Pure functions, so the
// arguments and the `rg --json` reading are checked without a host.

/** One matching line of `rg --json`, with positions counted from zero in UTF-16 units. */
export interface ContentMatch {
  /** The path relative to the directory searched. */
  path: string;
  line: number;
  /** Where the first match on the line starts. */
  column: number;
  /** Where the first match on the line ends. */
  endColumn: number;
  /** The line's text without its line break. */
  text: string;
}

/** The most matching lines a content search shows. */
export const MAX_MATCHES = 300;

/** The most files the file list holds. */
export const MAX_FILES = 50_000;

/** The most matching lines one file contributes, so a single noisy file cannot fill the list. */
const MAX_MATCHES_PER_FILE = 12;

/** The longest line `rg` prints in full; longer ones are cut, so a minified bundle cannot flood the list. */
const MAX_COLUMNS = 400;

/** The arguments that list every file below the directory, hidden ones too, except what ignore files and `.git` exclude. */
export function fileListArguments(): string[] {
  return ["--files", "--hidden", "--no-require-git", "--glob", "!.git", "--sort", "path"];
}

/** The arguments that search the text of those files for `query`, as plain text that ignores case unless it has capitals. */
export function contentArguments(query: string): string[] {
  return [
    "--json",
    "--fixed-strings",
    "--smart-case",
    "--hidden",
    "--no-require-git",
    "--glob",
    "!.git",
    "--max-count",
    String(MAX_MATCHES_PER_FILE),
    "--max-columns",
    String(MAX_COLUMNS),
    "--max-columns-preview",
    "-e",
    query,
    ".",
  ];
}

/** A path as ripgrep prints it, without the `./` that searching `.` puts in front. */
export function cleanPath(path: string): string {
  if (path.startsWith("./")) {
    return path.slice(2);
  }
  return path;
}

/** The matches in the lines `rg --json` printed; lines that are not matches, or are not JSON, are skipped. */
export function parseMatches(lines: string[]): ContentMatch[] {
  const matches: ContentMatch[] = [];
  for (const line of lines) {
    const match = parseMatch(line);
    if (match !== null) {
      matches.push(match);
    }
  }
  return matches;
}

/** The match one `rg --json` line reports, or null when it is another event or cannot be read. */
export function parseMatch(line: string): ContentMatch | null {
  let event: RipgrepEvent;
  try {
    event = JSON.parse(line) as RipgrepEvent;
  } catch {
    return null;
  }
  if (event.type !== "match" || event.data === undefined) {
    return null;
  }
  const { path, lines, line_number: lineNumber, submatches } = event.data;
  // A path or a line that is not UTF-8 comes as base64 bytes, which no preview can show.
  if (path.text === undefined || lines.text === undefined) {
    return null;
  }
  const text = lines.text.replace(/\r?\n$/, "");
  const first = firstSubmatch(submatches);
  return {
    path: cleanPath(path.text),
    line: lineNumber - 1,
    column: columnOfByte(text, first.start),
    endColumn: columnOfByte(text, first.end),
    text,
  };
}

interface RipgrepEvent {
  type: string;
  data?: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
    submatches: { start: number; end: number }[];
  };
}

/** The first match on a line, or an empty one at the start when ripgrep named none. */
function firstSubmatch(submatches: { start: number; end: number }[]): { start: number; end: number } {
  if (submatches.length === 0) {
    return { start: 0, end: 0 };
  }
  return submatches[0];
}

/**
 * The UTF-16 column of a UTF-8 byte offset in `text`: ripgrep counts bytes, the editor counts the
 * units JavaScript strings are made of.
 */
export function columnOfByte(text: string, byteOffset: number): number {
  let bytes = 0;
  let column = 0;
  for (const character of text) {
    if (bytes >= byteOffset) {
      return column;
    }
    bytes += utf8Length(character.codePointAt(0)!);
    column += character.length;
  }
  return column;
}

/** How many bytes UTF-8 uses for a code point. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}
