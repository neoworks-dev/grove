import { describe, expect, test } from 'bun:test'
import { nvimBlockingPrompt, nvimPromptChoices } from '../src/renderer/src/lib/nvim/blockingPrompt'
import { applyMultigridRedraw, createMultigridState } from '../src/renderer/src/lib/nvim/multigrid'
import type { MultigridState } from '../src/renderer/src/lib/nvim/multigrid'

/** An 80x20 outer grid with one window on it and a message grid beside it. */
function attached(): MultigridState {
  const state = createMultigridState()
  applyMultigridRedraw(state, [
    ['grid_resize', [1, 80, 20], [2, 80, 19], [3, 80, 20]],
    ['win_pos', [2, 1000, 0, 0, 80, 19]],
    ['msg_set_pos', [3, 19]],
    ['flush', []]
  ])
  return state
}

/** Write one line of text into a grid, as nvim's grid_line would. */
function writeLine(state: MultigridState, grid: number, row: number, text: string): void {
  applyMultigridRedraw(state, [
    ['grid_line', [grid, row, 0, [...text].map((character) => [character]), false]],
    ['flush', []]
  ])
}

describe('nvim blocking prompts', () => {
  test('the cmdline row alone is not a prompt', () => {
    const state = attached()
    writeLine(state, 3, 0, ':checktime')

    expect(nvimBlockingPrompt(state)).toBeNull()
  })

  test('a message area taller than the cmdline is the prompt nvim is stopped on', () => {
    const state = attached()
    applyMultigridRedraw(state, [
      ['msg_set_pos', [3, 17]],
      ['flush', []]
    ])
    writeLine(state, 3, 0, ':checktime')
    writeLine(state, 3, 1, 'W13: Warning: File "notyet.ts" has been created after editing started')
    writeLine(state, 3, 2, '[O]K, (L)oad File:')

    expect(nvimBlockingPrompt(state)).toEqual([
      ':checktime',
      'W13: Warning: File "notyet.ts" has been created after editing started',
      '[O]K, (L)oad File:'
    ])
  })

  test('answering the prompt withdraws it', () => {
    const state = attached()
    applyMultigridRedraw(state, [
      ['msg_set_pos', [3, 17]],
      ['flush', []]
    ])
    writeLine(state, 3, 2, '[O]K, (L)oad File:')
    expect(nvimBlockingPrompt(state)).not.toBeNull()

    applyMultigridRedraw(state, [
      ['msg_set_pos', [3, 19]],
      ['flush', []]
    ])
    expect(nvimBlockingPrompt(state)).toBeNull()
  })

  test('a resize of the message grid does not make every message look like a prompt', () => {
    // The message grid is allocated at the full outer height, so its own rows
    // say nothing about how much of the screen it covers.
    const state = attached()
    applyMultigridRedraw(state, [
      ['grid_resize', [3, 80, 20]],
      ['flush', []]
    ])
    writeLine(state, 3, 0, ':w')

    expect(nvimBlockingPrompt(state)).toBeNull()
  })

  test('trailing blank rows are not part of the prompt', () => {
    const state = attached()
    applyMultigridRedraw(state, [
      ['msg_set_pos', [3, 16]],
      ['flush', []]
    ])
    writeLine(state, 3, 0, 'Press ENTER or type command to continue')

    expect(nvimBlockingPrompt(state)).toEqual(['Press ENTER or type command to continue'])
  })
})

describe('nvim prompt choices', () => {
  test('reads the keys nvim brackets in the question', () => {
    expect(nvimPromptChoices('[O]K, (L)oad File, Load File (a)nd Options:')).toEqual([
      { key: 'O', label: 'OK' },
      { key: 'L', label: 'Load File' },
      { key: 'a', label: 'Load File and Options' }
    ])
  })

  test('a prompt that takes any key offers no choices', () => {
    expect(nvimPromptChoices('Press ENTER or type command to continue')).toEqual([])
  })
})
