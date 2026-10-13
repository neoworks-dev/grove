import { describe, expect, test } from 'bun:test'
import { activeLandscape, starBackground } from '../src/renderer/src/lib/landscape'
import { themeFor } from '../src/renderer/src/lib/themes'

describe('activeLandscape', () => {
  test('the scrapbook themes draw a day and a night scene', () => {
    expect(activeLandscape(themeFor('neoworks-scrapbook-light'), true)?.night).toBe(false)
    expect(activeLandscape(themeFor('neoworks-scrapbook'), true)?.night).toBe(true)
  })

  test('the Neoworks themes draw none', () => {
    expect(activeLandscape(themeFor('neoworks'), true)).toBeUndefined()
    expect(activeLandscape(themeFor('neoworks-light'), true)).toBeUndefined()
  })

  test('the mascot setting turns the scene off', () => {
    expect(activeLandscape(themeFor('neoworks-scrapbook'), false)).toBeUndefined()
  })
})

describe('starBackground', () => {
  test('scatters one gradient per star in the given colour', () => {
    const background = starBackground('red')
    expect(background.split('radial-gradient').length - 1).toBe(16)
    expect(background).toContain('red 50%')
  })
})
