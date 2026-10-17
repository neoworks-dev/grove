// How a line blamed to an agent prompt reads at the end of the line. Ported from the Electron
// app's `blameLabel`, so the two say the same thing.

import type { LineBlame } from "../../../src/shared/agents";
import { relativeTime } from "../git-gutter/changes";

/** The name of the set of decorations prompt blame owns. It sorts before `git.blame`, so on a line it fills the blame it shows is this one. */
export const PROMPT_BLAME_SOURCE = "agent.blame";

/** A prompt's first line, cut to fit beside a line of code. */
export function promptHeadline(prompt: string, limit: number = 60): string {
  const firstLine = prompt.trim().split("\n")[0];
  if (firstLine.length <= limit) {
    return firstLine;
  }
  return `${firstLine.slice(0, limit - 1)}…`;
}

/**
 * The end-of-line text for a blamed line, or null for a line no prompt wrote. It says why the
 * agent wrote the line first (its own explanation, else the prompt it was answering), then the
 * commit, or that the line is not committed yet.
 */
export function promptLabel(blame: LineBlame, nowMilliseconds: number): string | null {
  const prompt = blame.prompt;
  if (!prompt) {
    return null;
  }
  const commit = commitText(blame, nowMilliseconds);
  if (prompt.explanation) {
    return `✦ ${promptHeadline(prompt.explanation, 70)}  ·  ${commit}`;
  }
  let headline = promptHeadline(prompt.prompt, 50);
  if (headline.length === 0) {
    headline = prompt.sessionTitle;
  }
  return `✦ “${headline}”  ·  ${commit}`;
}

/** Who committed the line, when and why, or that it is not committed. */
function commitText(blame: LineBlame, nowMilliseconds: number): string {
  if (!blame.commit) {
    return "uncommitted";
  }
  const when = relativeTime(blame.commit.time, nowMilliseconds);
  return `${blame.commit.author}, ${when} · ${blame.commit.summary}`;
}
