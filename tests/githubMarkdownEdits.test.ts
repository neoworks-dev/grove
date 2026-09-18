// The composer's formatting buttons. Each is "wrap the selection" or "prefix
// the lines", and the awkward cases — nothing selected, already formatted,
// several lines — are what these pin.

import { describe, it, expect } from 'bun:test'
import { applyMarkdownEdit } from '../src/renderer/src/kernel/plugins/github/markdownEdits'

describe('applyMarkdownEdit: wrapping', () => {
  it('wraps the selection and leaves it selected', () => {
    const result = applyMarkdownEdit('make this bold', 10, 14, 'bold')
    expect(result.text).toBe('make this **bold**')
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('bold')
  })

  it('inserts a placeholder when nothing is selected, and selects it', () => {
    const result = applyMarkdownEdit('', 0, 0, 'bold')
    expect(result.text).toBe('**bold text**')
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('bold text')
  })

  it('unwraps when the selection is already wrapped', () => {
    const result = applyMarkdownEdit('say **loud** now', 6, 10, 'bold')
    expect(result.text).toBe('say loud now')
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('loud')
  })

  it('leaves room for the href a link needs', () => {
    const result = applyMarkdownEdit('grove', 0, 5, 'link')
    expect(result.text).toBe('[grove](url)')
  })
})

describe('applyMarkdownEdit: line prefixes', () => {
  it('prefixes the line the caret sits on', () => {
    const result = applyMarkdownEdit('a title', 3, 3, 'heading')
    expect(result.text).toBe('### a title')
  })

  it('prefixes every line the selection touches', () => {
    const result = applyMarkdownEdit('one\ntwo\nthree', 0, 13, 'bullets')
    expect(result.text).toBe('- one\n- two\n- three')
  })

  it('numbers an ordered list in order', () => {
    const result = applyMarkdownEdit('one\ntwo\nthree', 0, 13, 'numbers')
    expect(result.text).toBe('1. one\n2. two\n3. three')
  })

  it('removes the prefix when every line already has it', () => {
    const result = applyMarkdownEdit('- one\n- two', 0, 11, 'bullets')
    expect(result.text).toBe('one\ntwo')
  })

  it('adds rather than removes when only some lines have it', () => {
    const result = applyMarkdownEdit('- one\ntwo', 0, 9, 'bullets')
    expect(result.text).toBe('- - one\n- two')
  })

  it('reaches the whole line from a caret in the middle of a block', () => {
    const result = applyMarkdownEdit('one\ntwo\nthree', 5, 5, 'quote')
    expect(result.text).toBe('one\n> two\nthree')
  })

  it('writes an unchecked box for a task', () => {
    const result = applyMarkdownEdit('do it', 0, 0, 'tasks')
    expect(result.text).toBe('- [ ] do it')
  })
})
