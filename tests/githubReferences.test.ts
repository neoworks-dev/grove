// Which issues and pull requests an agent's message refers to, for the cards
// the agent pane shows under it. A miss costs a card; a false hit shows an
// unrelated issue as if the agent had meant it, which is worse.

import { describe, expect, test } from 'bun:test'
import {
  githubReferences,
  parseReference
} from '../src/renderer/src/kernel/plugins/github/references'

describe('githubReferences', () => {
  test('finds bare numbers and links, in order, once each', () => {
    const text =
      'Fixed in #212, see https://github.com/neoworks-dev/grove/pull/220 and (#211). #212 again.'

    expect(githubReferences(text)).toEqual(['212', 'neoworks-dev/grove#220', '211'])
  })

  test('ignores code', () => {
    const text = 'Colour `#123456` and\n```\ngit log #99\n```\nbut #7 counts'

    expect(githubReferences(text)).toEqual(['7'])
  })

  test('ignores places in a list', () => {
    expect(githubReferences('Step #1 then option #2, and No. #3')).toEqual([])
  })

  test('ignores anchors and words that only contain a hash', () => {
    expect(githubReferences('see README.md#12 and C#9 and #12abc')).toEqual([])
  })

  test('issue and PR words still count', () => {
    expect(githubReferences('Issue #5 and PR #6')).toEqual(['5', '6'])
  })
})

describe('parseReference', () => {
  test('splits a link key into repository and number', () => {
    expect(parseReference('neoworks-dev/grove#220')).toEqual({
      repo: 'neoworks-dev/grove',
      number: 220
    })
    expect(parseReference('212')).toEqual({ repo: null, number: 212 })
  })
})
