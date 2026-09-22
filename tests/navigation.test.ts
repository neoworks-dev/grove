import { describe, expect, test } from 'bun:test'
import { isAppNavigation, isExternallyOpenable } from '../src/main/navigation'

describe('isAppNavigation', () => {
  test('keeps the dev server on its own origin', () => {
    expect(isAppNavigation('http://localhost:5173/', 'http://localhost:5173/#pane')).toBe(true)
  })

  test('refuses a link out of the dev server', () => {
    expect(isAppNavigation('http://localhost:5173/', 'https://github.com/neoworks-dev/grove')).toBe(false)
  })

  test('keeps the packaged document, refuses another file', () => {
    const app = 'file:///opt/grove/resources/app/out/renderer/index.html'
    expect(isAppNavigation(app, `${app}#x`)).toBe(true)
    expect(isAppNavigation(app, 'file:///etc/passwd')).toBe(false)
  })

  test('refuses what does not parse', () => {
    expect(isAppNavigation('http://localhost:5173/', 'not a url')).toBe(false)
  })
})

describe('isExternallyOpenable', () => {
  test('opens web and mail links', () => {
    expect(isExternallyOpenable('https://github.com')).toBe(true)
    expect(isExternallyOpenable('http://example.com')).toBe(true)
    expect(isExternallyOpenable('mailto:a@b.c')).toBe(true)
  })

  test('drops local files and other schemes', () => {
    expect(isExternallyOpenable('file:///etc/passwd')).toBe(false)
    expect(isExternallyOpenable('javascript:alert(1)')).toBe(false)
    expect(isExternallyOpenable('smb://host/share')).toBe(false)
  })
})
