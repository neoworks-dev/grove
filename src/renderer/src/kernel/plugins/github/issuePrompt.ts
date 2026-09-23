// The prompt an agent is briefed with when it starts on an issue: the issue and
// nothing else. How to branch, commit and open a pull request is the repository's
// own instructions' business, and repeating it here would drift from them.

import type { GithubComment, GithubItemDetail } from '../../../../../shared/types'

/** The issue as a prompt: title and number, labels, link, body, then the comment thread. */
export function issuePrompt(detail: GithubItemDetail): string {
  const sections = [`Issue #${detail.number}: ${detail.title}`, detail.url]
  if (detail.labels.length > 0) {
    sections.push(`Labels: ${detail.labels.map((label) => label.name).join(', ')}`)
  }
  sections.push(bodyOf(detail.body))
  const comments = commentsOf(detail)
  if (comments.length > 0) {
    sections.push(['## Comments', ...comments.map(commentBlock)].join('\n\n'))
  }
  return sections.join('\n\n')
}

/** The issue's body, or a note that it has none. */
function bodyOf(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return '(No description.)'
  return trimmed
}

/** The comments in the issue's timeline, oldest first as the timeline has them. */
function commentsOf(detail: GithubItemDetail): GithubComment[] {
  const comments: GithubComment[] = []
  for (const entry of detail.timeline) {
    if (entry.type === 'comment') comments.push(entry.comment)
  }
  return comments
}

/** One comment, headed by who wrote it and when. */
function commentBlock(comment: GithubComment): string {
  const day = comment.createdAt.slice(0, 10)
  return `**@${comment.author.login}** (${day}):\n${comment.body.trim()}`
}
