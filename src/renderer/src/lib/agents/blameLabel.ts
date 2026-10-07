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
 * why the agent wrote it first (its own explanation, else the prompt it was
 * answering), then the commit (or that it is uncommitted). The session's name
 * is left to opening it.
 */
export function blameLabel(blame: LineBlame, now: number = Date.now()): string | null {
  const prompt = blame.prompt
  if (!prompt) return null
  let commit = 'uncommitted'
  if (blame.commit) {
    const when = ageLabel(new Date(blame.commit.time).toISOString(), now)
    commit = `${blame.commit.author}, ${when} · ${blame.commit.summary}`
  }
  if (prompt.explanation) {
    return `✦ ${promptHeadline(prompt.explanation, 70)}  ·  ${commit}`
  }
  let headline = promptHeadline(prompt.prompt, 50)
  if (headline.length === 0) headline = prompt.sessionTitle
  return `✦ “${headline}”  ·  ${commit}`
}

/** One line appended to the blame popup, and the highlight group it is drawn in ('' for none). */
export type BlamePopupLine = [text: string, highlight: string]

/**
 * The first line of the blame popup nvim opens itself, for a line gitsigns has
 * no popup for (an untracked file): the commit, or that the line has none.
 */
export function blamePopupHeading(blame: LineBlame): string {
  if (!blame.commit) return 'Not committed yet'
  return `${blame.commit.sha.slice(0, 8)} ${blame.commit.author}: ${blame.commit.summary}`
}

/**
 * The lines <leader>gb appends to the blame popup for a line an agent wrote:
 * who wrote it, the agent's explanation, then the whole prompt it answered.
 * Empty for a line no prompt wrote.
 */
export function blamePopupLines(blame: LineBlame, now: number = Date.now()): BlamePopupLine[] {
  const prompt = blame.prompt
  if (!prompt) return []
  const when = ageLabel(prompt.at, now)
  const lines: BlamePopupLine[] = [[`✦ ${prompt.harness} · ${prompt.sessionTitle} (${when})`, 'Title']]
  if (prompt.explanation) {
    for (const text of prompt.explanation.trim().split('\n')) lines.push([text, 'NormalFloat'])
  }
  const promptText = prompt.prompt.trim()
  if (promptText.length === 0) return lines
  lines.push(['', ''])
  lines.push([`Prompt from ${prompt.from}:`, 'Label'])
  for (const text of promptText.split('\n')) lines.push([text, 'Comment'])
  return lines
}
