import { expect, test } from 'bun:test'
import { EDITOR_ACTIONS, luaCommandKeys } from '../src/renderer/src/lib/editorActionTable'
import { formatStep, parseSequence, sequenceStartsWith } from '../src/renderer/src/lib/keySequence'

/** The parsed steps of an action's keys, failing the test when they don't parse. */
function stepsOf(keys: string): NonNullable<ReturnType<typeof parseSequence>>['steps'] {
  const parsed = parseSequence(keys)
  if (parsed === null) {
    throw new Error(`"${keys}" does not parse`)
  }
  return parsed.steps
}

test('every action runs something', () => {
  for (const action of EDITOR_ACTIONS) {
    expect(action.lua !== undefined || action.toggle !== undefined).toBe(true)
  }
})

test('ids are unique', () => {
  const ids = EDITOR_ACTIONS.map((action) => action.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('no action shadows another by sitting on its prefix', () => {
  for (const action of EDITOR_ACTIONS) {
    const steps = stepsOf(action.keys)
    for (const other of EDITOR_ACTIONS) {
      if (other === action) continue
      expect(sequenceStartsWith(stepsOf(other.keys), steps)).toBe(false)
    }
  }
})

test('actions under one leader prefix share a group, so which-key names it once', () => {
  const groupByPrefix = new Map<string, string>()
  for (const action of EDITOR_ACTIONS) {
    const prefix = formatStep(stepsOf(action.keys)[0])
    const known = groupByPrefix.get(prefix)
    if (known === undefined) {
      groupByPrefix.set(prefix, action.group)
      continue
    }
    expect(`${prefix}: ${action.group}`).toBe(`${prefix}: ${known}`)
  }
})

test('Lua runs through <Cmd> with literal < escaped for nvim_input', () => {
  expect(luaCommandKeys('vim.lsp.buf.rename()')).toBe('<Cmd>lua vim.lsp.buf.rename()<CR>')
  expect(luaCommandKeys('print(1 < 2)')).toBe('<Cmd>lua print(1 <lt> 2)<CR>')
})
