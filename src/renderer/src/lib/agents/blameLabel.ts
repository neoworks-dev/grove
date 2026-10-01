// How a line blamed to an agent prompt reads in the editor.

import { ageLabel } from '../time'
import type { LineBlame } from '../../../../shared/agents'

/** A prompt's first line, cut to fit beside a line of code. */
export function promptHeadline(prompt: string, limit = 60): string {
  const firstLine = prompt.trim().split('\n')[0]
  if (firstLine.length <= limit) return firstLine
  return `${firstLine.slice(0, limit - 1)}…`
}

/**
 * The end-of-line text for a blamed line, or null for a line no prompt wrote:
 * the prompt first, since it is what the line is shown for, then the commit
 * (or that it is uncommitted). The session's name is left to opening it.
 */
export function blameLabel(blame: LineBlame, now: number = Date.now()): string | null {
  const prompt = blame.prompt
  if (!prompt) return null
  let commit = 'uncommitted'
  if (blame.commit) {
    const when = ageLabel(new Date(blame.commit.time).toISOString(), now)
    commit = `${blame.commit.author}, ${when} · ${blame.commit.summary}`
  }
  let headline = promptHeadline(prompt.prompt, 50)
  if (headline.length === 0) headline = prompt.sessionTitle
  return `✦ “${headline}”  ·  ${commit}`
}
