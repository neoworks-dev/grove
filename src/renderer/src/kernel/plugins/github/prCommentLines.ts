// A review thread as the lines Neovim draws under the code it is about.
//
// Comments belong beside the line they were left on — that is where they were
// written and where they are read — so they go into the buffer as virtual
// lines rather than into a pane somewhere else in the window.

import type { GithubReviewThread } from '../../../../../shared/types'

/** One virtual line: its text, and the highlight group Neovim draws it in. */
export interface CommentVirtualLine {
  text: string
  hl: string
}

/** Marks the block out from the code above and below it. */
const GUTTER = '▏ '

/** How wide a comment may run before it is wrapped onto the next line. */
export const COMMENT_WIDTH = 96

/**
 * The lines for one thread: who said what, in order, with a draft marked as
 * one. An empty thread draws nothing rather than an empty block.
 */
export function threadVirtualLines(
  thread: GithubReviewThread,
  width = COMMENT_WIDTH
): CommentVirtualLine[] {
  const lines: CommentVirtualLine[] = []
  for (const comment of thread.comments) {
    const badge = comment.pending ? ' · draft' : ''
    lines.push({ text: `${GUTTER}${comment.author.login}${badge}`, hl: headingGroup(comment.pending) })
    for (const text of wrap(comment.body, width)) {
      lines.push({ text: `${GUTTER}${text}`, hl: 'Comment' })
    }
  }
  if (lines.length > 0 && thread.isResolved) {
    lines.push({ text: `${GUTTER}resolved`, hl: 'Comment' })
  }
  return lines
}

/** A draft is the viewer's own unsent note, and is worth telling apart. */
function headingGroup(pending: boolean): string {
  if (pending) return 'WarningMsg'
  return 'Title'
}

/**
 * Break a comment into lines that fit. Paragraphs the author typed are kept;
 * anything longer than the width is broken between words, and a single word
 * too long to fit is left over the edge rather than cut in half.
 */
export function wrap(body: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of body.replace(/\r/g, '').split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    for (const word of paragraph.split(/\s+/).filter((entry) => entry.length > 0)) {
      if (current.length === 0) {
        current = word
        continue
      }
      if (current.length + 1 + word.length <= width) {
        current = `${current} ${word}`
        continue
      }
      lines.push(current)
      current = word
    }
    if (current.length > 0) lines.push(current)
  }
  return lines
}
