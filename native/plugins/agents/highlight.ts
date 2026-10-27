// Syntax colours for the code in the chat: the host parses a text in the language of a file name
// and says which runs of each line have a highlight (`syntax_highlight`, src/highlight.rs); the
// theme's syntax table, the editor's, says what colour each name gets. Plain functions and a
// cache, so they are tested without a window. Ported in spirit from neo term, which highlights its
// chat's edits by the file's grammar on a green or red tint.

import type { SyntaxStyle } from "../theme/editorTheme";

/** A run the host found: where it starts and ends in the line, in characters, and what it is. */
export type HostRun = [start: number, end: number, name: string];

/** What the host answers. */
export interface HostHighlight {
  language: string | null;
  lines: HostRun[][];
}

/** Asks the host to parse a text as the language `path` names. */
export type HighlightHost = (text: string, path: string) => Promise<HostHighlight>;

/** A stretch of a line with one colour. */
export interface Run {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

/** The style the table gives a highlight name, else its dotted prefix's (`keyword.return` takes `keyword`). */
export function styleOf(name: string, syntax: Record<string, SyntaxStyle>): SyntaxStyle | undefined {
  let candidate = name;
  while (candidate !== "") {
    const style = syntax[candidate];
    if (style !== undefined) {
      return style;
    }
    const dot = candidate.lastIndexOf(".");
    if (dot < 0) {
      return undefined;
    }
    candidate = candidate.slice(0, dot);
  }
  return undefined;
}

/** A line cut into runs: what the host highlighted in its colours, and what lies between as it is. */
export function runsOf(line: string, found: readonly HostRun[], syntax: Record<string, SyntaxStyle>): Run[] {
  const characters = Array.from(line);
  const runs: Run[] = [];
  let at = 0;
  for (const [start, end, name] of found) {
    const from = Math.max(start, at);
    const to = Math.min(end, characters.length);
    if (from >= to) {
      continue;
    }
    if (from > at) {
      runs.push({ text: characters.slice(at, from).join("") });
    }
    runs.push(styled(characters.slice(from, to).join(""), styleOf(name, syntax)));
    at = to;
  }
  if (at < characters.length) {
    runs.push({ text: characters.slice(at).join("") });
  }
  return runs;
}

/** A run of text in a style. */
function styled(text: string, style: SyntaxStyle | undefined): Run {
  if (style === undefined) {
    return { text };
  }
  if (typeof style === "string") {
    return { text, color: style };
  }
  const run: Run = { text, color: style.color };
  if (style.bold) {
    run.bold = true;
  }
  if (style.italic) {
    run.italic = true;
  }
  return run;
}

/** How many highlighted texts are kept. */
const KEPT = 200;

/** Highlights texts through the host and remembers the answers, since the same lines are drawn on every frame. */
export class Highlighter {
  private host: HighlightHost;
  private known = new Map<string, Promise<HostHighlight | undefined>>();

  constructor(host: HighlightHost) {
    this.host = host;
  }

  /** The runs of each line of `text`, as `path` says what language it is; undefined for a language the host does not know or a failure. */
  async lines(text: string, path: string, syntax: Record<string, SyntaxStyle>): Promise<Run[][] | undefined> {
    const answer = await this.ask(text, path);
    if (answer === undefined || answer.language === null) {
      return undefined;
    }
    const lines = text.split("\n");
    return lines.map((line, index) => runsOf(line, answer.lines[index] ?? [], syntax));
  }

  /** The host's answer for a text, asked once while it is kept. */
  private ask(text: string, path: string): Promise<HostHighlight | undefined> {
    const key = `${path}\u0000${text}`;
    const kept = this.known.get(key);
    if (kept !== undefined) {
      return kept;
    }
    const asked = this.host(text, path).catch(() => undefined);
    this.known.set(key, asked);
    if (this.known.size > KEPT) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) {
        this.known.delete(oldest);
      }
    }
    return asked;
  }
}
