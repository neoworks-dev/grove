// The lines an agent points at, as the editor paints them.
//
// The mark is only a pointer, so it has to get out of the way the moment the
// user is done with it: on their first edit to the buffer, or on Esc in normal
// mode — and that Esc must still do whatever it did before the mark was there.
// Runs the bundled nvim headless, with its own XDG dirs so the user's are
// never touched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NvimRpc } from '../src/main/nvimRpc'
import { CLEAR_MARKS_LUA, MARK_LINES_LUA } from '../src/renderer/src/lib/nvim/agentMarks'

const NVIM = join(
  import.meta.dir,
  '..',
  'resources',
  'nvim',
  'dist',
  `${process.platform}-${process.arch}`,
  'bin',
  'nvim'
)

const COUNT_MARKS = `
return #vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('grove_agent_marks'), 0, -1, {})
`

let home: string
let child: ChildProcess
let nvim: NvimRpc

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'grove-marks-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    env[`XDG_${name}_HOME`] = join(home, name.toLowerCase())
  }
  child = spawn(NVIM, ['--embed', '--headless', '--clean', '-n'], { env })
  nvim = new NvimRpc(child.stdin!, child.stdout!)
  await nvim.request('nvim_exec_lua', [
    `vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'one', 'two', 'three', 'four', 'five' })
     vim.bo.modified = false
     -- Stands in for the bundled config's own normal-mode Esc.
     vim.keymap.set('n', '<Esc>', function() vim.g.esc_ran = true end)`,
    []
  ])
})

afterEach(async () => {
  nvim.close()
  child.kill()
  await rm(home, { recursive: true, force: true })
})

/** How many agent marks the current buffer has. */
async function markCount(): Promise<number> {
  return (await nvim.request('nvim_exec_lua', [COUNT_MARKS, []])) as number
}

/** Marks lines 2–3 with a note, as opening a location does. */
async function markLines(): Promise<void> {
  await nvim.request('nvim_exec_lua', [MARK_LINES_LUA, [2, 3, 'Look here.', [{ line: 3, text: 'And here.' }]]])
}

/** Types keys as the user would, and waits for nvim to have handled them. */
async function press(keys: string): Promise<void> {
  await nvim.request('nvim_input', [keys])
  await nvim.request('nvim_eval', ['1'])
  await Bun.sleep(50)
}

describe.skipIf(!existsSync(NVIM))('dismissing an agent mark', () => {
  test('moving around leaves it in place', async () => {
    await markLines()
    expect(await markCount()).toBeGreaterThan(0)

    await press('jk')

    expect(await markCount()).toBeGreaterThan(0)
  })

  test('the first edit clears it', async () => {
    await markLines()

    await press('x')

    expect(await markCount()).toBe(0)
  })

  test('Esc in normal mode clears it, and still does what Esc did', async () => {
    await markLines()

    await press('<Esc>')

    expect(await markCount()).toBe(0)
    expect(await nvim.request('nvim_get_var', ['esc_ran'])).toBe(true)
  })

  test('once cleared, Esc is left as it was', async () => {
    await markLines()
    await press('<Esc>')
    await nvim.request('nvim_set_var', ['esc_ran', false])

    await press('<Esc>')

    expect(await nvim.request('nvim_get_var', ['esc_ran'])).toBe(true)
    const localMaps = await nvim.request('nvim_buf_get_keymap', [0, 'n'])
    expect(localMaps).toEqual([])
  })

  test('clearing from the app takes the Esc and the edit watch with it', async () => {
    await markLines()

    await nvim.request('nvim_exec_lua', [CLEAR_MARKS_LUA, []])

    expect(await markCount()).toBe(0)
    expect(await nvim.request('nvim_buf_get_keymap', [0, 'n'])).toEqual([])
    const watching = await nvim.request('nvim_exec_lua', [
      `return pcall(vim.api.nvim_get_autocmds, { group = 'grove_agent_marks' })`,
      []
    ])
    expect(watching).toBe(false)
  })
})
