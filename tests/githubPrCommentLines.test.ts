import { describe, it, expect } from 'bun:test'
import {
  threadVirtualLines,
  wrap
} from '../src/renderer/src/kernel/plugins/github/prCommentLines'
import type { GithubReviewThread } from '../src/shared/types'

function comment(body: string, login = 'octocat', pending = false) {
  return {
    id: `c-${body.slice(0, 4)}`,
    author: { login, avatarUrl: null },
    body,
    createdAt: '2026-09-20T10:00:00Z',
    pending
  }
}

function thread(overrides: Partial<GithubReviewThread> = {}): GithubReviewThread {
  return {
    id: 'PRRT_1',
    path: 'src/format.ts',
    line: 4,
    side: 'RIGHT',
    isResolved: false,
    pending: false,
    comments: [comment('Is the pad enough?')],
    ...overrides
  }
}

/** The text of the drawn lines, with the gutter taken off. */
function texts(thread: GithubReviewThread, width = 96): string[] {
  return threadVirtualLines(thread, width).map((line) => line.text.replace(/^▏ /, ''))
}

describe('threadVirtualLines', () => {
  it('names the author above what they said', () => {
    expect(texts(thread())).toEqual(['octocat', 'Is the pad enough?'])
  })

  it('marks a draft, so an unsent note is not mistaken for a sent one', () => {
    const draft = thread({ comments: [comment('Not sent yet', 'octocat', true)] })
    expect(texts(draft)[0]).toBe('octocat · draft')
    expect(threadVirtualLines(draft)[0].hl).toBe('WarningMsg')
  })

  it('draws a whole conversation, in the order it happened', () => {
    const talked = thread({
      comments: [comment('Why trim here?', 'octocat'), comment('Legacy input', 'hubot')]
    })
    expect(texts(talked)).toEqual(['octocat', 'Why trim here?', 'hubot', 'Legacy input'])
  })

  it('says when a thread has been settled', () => {
    expect(texts(thread({ isResolved: true })).at(-1)).toBe('resolved')
  })

  it('draws nothing for a thread with nothing in it', () => {
    expect(threadVirtualLines(thread({ comments: [] }))).toEqual([])
  })

  it('keeps the gutter on every line, so the block reads as one', () => {
    for (const line of threadVirtualLines(thread())) {
      expect(line.text.startsWith('▏ ')).toBe(true)
    }
  })
})

describe('wrap', () => {
  it('breaks between words rather than through them', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  it('keeps the paragraphs the author typed', () => {
    expect(wrap('first\n\nsecond', 40)).toEqual(['first', '', 'second'])
  })

  // Cutting a URL in half makes it useless, and the line running long is the
  // lesser harm.
  it('leaves a word too long to fit over the edge', () => {
    expect(wrap('see https://example.invalid/a/very/long/path now', 10)).toEqual([
      'see',
      'https://example.invalid/a/very/long/path',
      'now'
    ])
  })

  it('has nothing to draw for an empty body', () => {
    expect(wrap('', 40)).toEqual([''])
  })
})
