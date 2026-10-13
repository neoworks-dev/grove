import { describe, expect, test } from 'bun:test'
import { availableThemes, themeTokens } from '../src/renderer/src/lib/themes'

describe('theme shape', () => {
  test('a theme without a shape sets no shape tokens', () => {
    const tokens = themeTokens('neoworks')
    expect(tokens['--button-radius']).toBeUndefined()
    expect(tokens['--radius-md']).toBeUndefined()
    expect(tokens['--bg']).toBeDefined()
  })

  test('the scrapbook themes set corners and shadows beside the palette', () => {
    for (const name of ['neoworks-scrapbook', 'neoworks-scrapbook-light']) {
      const tokens = themeTokens(name)
      expect(tokens['--button-radius']).toBe('6px')
      expect(tokens['--radius-md']).toBe('4px')
      expect(tokens['--popover-shadow']).toContain('rgba')
      expect(tokens['--primary']).toBeDefined()
    }
  })

  test('the scrapbook themes are listed for the picker', () => {
    const names = availableThemes().map((theme) => theme.name)
    expect(names).toContain('neoworks-scrapbook')
    expect(names).toContain('neoworks-scrapbook-light')
  })
})
