import { describe, expect, test } from 'bun:test'
import { acceptableMascot, resolveMascotUrl } from '../src/renderer/src/lib/mascot'
import { themeFor } from '../src/renderer/src/lib/themes'
import type { ColorTheme } from '../src/renderer/src/lib/themes'

const withMascot: ColorTheme = {
  ...themeFor('neoworks'),
  mascot: { empty: 'data:image/png;base64,AAAA' }
}

describe('resolveMascotUrl', () => {
  test('returns the theme image for a pose it has', () => {
    expect(resolveMascotUrl(withMascot, 'empty', true)).toBe('data:image/png;base64,AAAA')
  })

  test('returns nothing for a pose the theme leaves out', () => {
    expect(resolveMascotUrl(withMascot, 'no-session', true)).toBeNull()
  })

  test('returns nothing when the setting is off', () => {
    expect(resolveMascotUrl(withMascot, 'empty', false)).toBeNull()
  })

  test('returns nothing for a theme without a mascot', () => {
    expect(resolveMascotUrl(themeFor('neoworks'), 'empty', true)).toBeNull()
  })
})

describe('acceptableMascot', () => {
  test('keeps data images and drops web addresses', () => {
    const accepted = acceptableMascot({
      empty: 'data:image/webp;base64,BBBB',
      'no-session': 'https://example.com/marmot.png'
    })
    expect(accepted).toEqual({ empty: 'data:image/webp;base64,BBBB' })
  })

  test('has nothing to keep when the theme brings no mascot', () => {
    expect(acceptableMascot(undefined)).toBeUndefined()
  })
})
