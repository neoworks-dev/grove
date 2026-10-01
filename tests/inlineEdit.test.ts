import { describe, expect, test } from 'bun:test'
import {
  chooseInlineSession,
  pickAgentMode,
  relFromRoot,
  reviewShownIn,
  selectionRef,
  workingTreeReviewSettled
} from '../src/renderer/src/lib/inlineEditRef'

describe('relFromRoot', () => {
  test('strips the worktree root prefix', () => {
    expect(relFromRoot('/home/me/wt', '/home/me/wt/src/foo.ts')).toBe('src/foo.ts')
  })

  test('passes through paths outside the worktree', () => {
    expect(relFromRoot('/home/me/wt', '/etc/hosts')).toBe('/etc/hosts')
  })

  test('does not treat a sibling dir with a shared prefix as inside', () => {
    expect(relFromRoot('/home/me/wt', '/home/me/wt-other/x.ts')).toBe('/home/me/wt-other/x.ts')
  })

  test('returns the absolute path when the root is unknown', () => {
    expect(relFromRoot(undefined, '/home/me/wt/src/foo.ts')).toBe('/home/me/wt/src/foo.ts')
  })
})

describe('selectionRef', () => {
  test('collapses a single-line selection to path:line', () => {
    expect(selectionRef('src/foo.ts', 12, 12)).toBe('src/foo.ts:12')
  })

  test('formats a multi-line range as path:start-end', () => {
    expect(selectionRef('src/foo.ts', 12, 20)).toBe('src/foo.ts:12-20')
  })
})

describe('pickAgentMode', () => {
  test('gated puts every write to the user before it lands', () => {
    expect(pickAgentMode('gated')).toBe('default')
  })

  test('inline applies the write, then reviews it with the in-buffer overlay', () => {
    expect(pickAgentMode('inline')).toBe('acceptEdits')
  })

  test('auto applies the write with no review at all', () => {
    expect(pickAgentMode('auto')).toBe('acceptEdits')
  })
})

describe('reviewShownIn', () => {
  const review = { leafId: 'leaf-2', absPath: '/wt/src/util.ts' }

  test('shows in its own pane while that pane shows the reviewed file', () => {
    expect(reviewShownIn(review, 'leaf-2', '/wt/src/util.ts')).toBe(true)
  })

  test('hides when its pane has switched to another file', () => {
    expect(reviewShownIn(review, 'leaf-2', '/wt/README.md')).toBe(false)
  })

  test('hides when its pane is on a non-file buffer', () => {
    expect(reviewShownIn(review, 'leaf-2', null)).toBe(false)
  })

  test('hides in another pane, even one showing the same file', () => {
    expect(reviewShownIn(review, 'leaf-7', '/wt/src/util.ts')).toBe(false)
  })
})

describe('workingTreeReviewSettled', () => {
  const review = { origin: 'workingTree' as const, worktreeId: 'wt-1', relPath: 'README.md' }

  test('a file that was committed leaves nothing to review', () => {
    expect(workingTreeReviewSettled(review, 'wt-1', ['src/index.ts'])).toBe(true)
  })

  test('a file that is still changed, staged or not, keeps its review', () => {
    expect(workingTreeReviewSettled(review, 'wt-1', ['README.md', 'src/index.ts'])).toBe(false)
  })

  test("another worktree's changes say nothing about it", () => {
    expect(workingTreeReviewSettled(review, 'wt-2', [])).toBe(false)
  })

  test('an inline edit is diffed against its own snapshot, not git, so it stays', () => {
    const inline = { ...review, origin: 'inlineEdit' as const }
    expect(workingTreeReviewSettled(inline, 'wt-1', [])).toBe(false)
  })
})

describe('chooseInlineSession', () => {
  const TITLE = 'Inline edits'
  const session = (id: string, harness: string, started: boolean, workspaceRoot = '/wt') => ({
    id,
    title: TITLE,
    workspaceRoot,
    harness,
    started
  })

  test('reuses the inline session already on the picked harness', () => {
    const sessions = [session('a', 'claude', true), session('b', 'codex', true)]
    const chosen = chooseInlineSession(sessions, '/wt', 'codex', 'a', TITLE)
    expect(chosen?.session.id).toBe('b')
    expect(chosen?.switchHarness).toBe(false)
  })

  test('switches an unstarted session to the picked harness', () => {
    const chosen = chooseInlineSession([session('a', 'claude', false)], '/wt', 'codex', 'a', TITLE)
    expect(chosen?.session.id).toBe('a')
    expect(chosen?.switchHarness).toBe(true)
  })

  test('needs a new session when every inline one started on another harness', () => {
    const chosen = chooseInlineSession([session('a', 'claude', true)], '/wt', 'codex', 'a', TITLE)
    expect(chosen).toBeNull()
  })

  test('prefers the remembered session and ignores other worktrees', () => {
    const sessions = [
      session('other', 'claude', true, '/elsewhere'),
      session('a', 'claude', true),
      session('b', 'claude', true)
    ]
    const chosen = chooseInlineSession(sessions, '/wt', 'claude', 'b', TITLE)
    expect(chosen?.session.id).toBe('b')
  })
})
