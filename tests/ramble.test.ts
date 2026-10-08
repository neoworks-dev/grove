// Rambles from the desktop overlay: the capture reads to the model as its
// words with what the user did in brackets where it happened, and to the user
// as runs of words with chips between.

import { describe, expect, test } from 'bun:test'
import { describeRamble, saidText, type RambleCapture } from '../src/shared/ramble'
import { rambleDuration, rambleSegments } from '../src/renderer/src/lib/agents/rambleCard'
import { overlayRunsUnasked } from '../src/main/agents/switchboard/overlay'

const KITTY = { kind: 'window', class: 'kitty', title: '~/grove' } as const

function capture(): RambleCapture {
  return {
    version: 1,
    startedAt: 1_000_000,
    endedAt: 1_065_000,
    words: [
      { text: 'why', at: 100 },
      { text: 'does', at: 400 },
      { text: 'this', at: 2000 },
      { text: 'fail?', at: 2300 }
    ],
    events: [
      { kind: 'circle', at: 1500, box: { monitor: 'DP-2', x: 10, y: 20, width: 300, height: 40 }, on: KITTY },
      { kind: 'screenshot', at: 1600, index: 0 },
      { kind: 'selection', at: 5000, text: 'TypeError: x is undefined' }
    ],
    screenshots: [{ path: '/tmp/ramble-1.png', monitor: 'DP-2', scale: 0.5 }],
    speechErrors: []
  }
}

describe('describeRamble', () => {
  test('puts each event before the first word said after it, and trailing ones last', () => {
    const lines = describeRamble(capture()).split('\n')
    expect(lines[0]).toContain('desktop-rambles skill')
    expect(lines[1]).toBe(
      'why does [circled window class:kitty "~/grove" at 10,20 on DP-2 (10,20 300x40)] [screenshot 1] this fail? [selected "TypeError: x is undefined"]'
    )
  })

  test('says which parts of the speech were lost', () => {
    const lost = { ...capture(), speechErrors: ['speech daemon not running'] }
    expect(describeRamble(lost)).toContain('[part of the speech was not transcribed: speech daemon not running]')
  })
})

describe('rambleSegments', () => {
  test('joins words into runs and labels events briefly, keeping the bracket as detail', () => {
    const segments = rambleSegments(capture())
    expect(segments.map((segment) => (segment.kind === 'words' ? segment.text : segment.label))).toEqual([
      'why does',
      'circled kitty',
      'screenshot 1',
      'this fail?',
      '“TypeError: x is undefined”'
    ])
    const circle = segments[1]
    expect(circle.kind === 'event' && circle.detail).toBe(
      'circled window class:kitty "~/grove" at 10,20 on DP-2 (10,20 300x40)'
    )
  })
})

describe('overlayRunsUnasked', () => {
  test("lets the overlay's tools through, but not typing that presses Return", () => {
    expect(overlayRunsUnasked('mcp__overlay__point', { target: 'class:kitty' })).toBe(true)
    expect(overlayRunsUnasked('mcp__overlay__type_text', { text: 'ls' })).toBe(true)
    expect(overlayRunsUnasked('mcp__overlay__type_text', { text: 'ls', enter: true })).toBe(false)
    expect(overlayRunsUnasked('mcp__overlay__more_tools', { args: { enter: true } })).toBe(false)
    expect(overlayRunsUnasked('mcp__other__point', {})).toBe(false)
    expect(overlayRunsUnasked('mcp__overlay__click', { target: 'point:10,10@shot1' })).toBe(false)
  })
})

test('the said text and the duration', () => {
  expect(saidText(capture())).toBe('why does this fail?')
  expect(rambleDuration(capture())).toBe('1m 5s')
})
