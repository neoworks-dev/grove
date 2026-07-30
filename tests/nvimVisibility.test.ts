import { describe, expect, test } from 'bun:test'
import { editorHasContent } from '../src/renderer/src/lib/nvim/visibility'

describe('editorHasContent', () => {
  test('hides the editor when nothing is open', () => {
    expect(
      editorHasContent({ tabCount: 0, visibleBufferCount: 0, reviewOwnsPane: false })
    ).toBe(false)
  })

  test('shows the editor for a grove tab', () => {
    expect(
      editorHasContent({ tabCount: 1, visibleBufferCount: 0, reviewOwnsPane: false })
    ).toBe(true)
  })

  test('shows the editor for a buffer opened inside nvim', () => {
    expect(
      editorHasContent({ tabCount: 0, visibleBufferCount: 1, reviewOwnsPane: false })
    ).toBe(true)
  })

  test('shows the editor while a review owns the pane', () => {
    expect(
      editorHasContent({ tabCount: 0, visibleBufferCount: 0, reviewOwnsPane: true })
    ).toBe(true)
  })
})
