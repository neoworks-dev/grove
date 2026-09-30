import { expect, test } from 'bun:test'
import {
  nvimGroupLabels,
  nvimKeymapBindings,
  nvimLeaderBindings,
  type NvimMapping
} from '../src/renderer/src/lib/nvimKeymap'

function keysFor(mappings: NvimMapping[]): string[] {
  return nvimKeymapBindings(mappings, 'editor', 'normal', () => {}).map((binding) => binding.keys)
}

test('space-leader maps become grove leader sequences', () => {
  expect(keysFor([{ lhs: '<Space>ff' }])).toEqual(['<Leader> f f'])
  expect(keysFor([{ lhs: ' gg' }])).toEqual(['<Leader> g g'])
})

test('chords inside a leader sequence are parsed', () => {
  expect(keysFor([{ lhs: '<Space><C-w>' }])).toEqual(['<Leader> <Ctrl-W>'])
})

test('named keys are translated', () => {
  expect(keysFor([{ lhs: '<Space><CR>' }])).toEqual(['<Leader> <Enter>'])
})

test('non-leader and bare maps are skipped', () => {
  expect(keysFor([{ lhs: 'gd' }, { lhs: 'zz' }, { lhs: '<C-w>h' }])).toEqual([])
})

test('duplicate leader sequences are de-duplicated', () => {
  expect(keysFor([{ lhs: '<Space>ff' }, { lhs: '<Space>ff' }])).toEqual(['<Leader> f f'])
})

test('description falls back through desc, rhs, then lhs', () => {
  const withDesc = nvimKeymapBindings([{ lhs: '<Space>a', desc: 'Do A' }], 'editor', 'normal', () => {})
  expect(withDesc[0].description).toBe('Do A')
  const withRhs = nvimKeymapBindings([{ lhs: '<Space>b', rhs: ':w<CR>' }], 'editor', 'normal', () => {})
  expect(withRhs[0].description).toBe(':w<CR>')
})

test('forward replays the original lhs', () => {
  const sent: string[] = []
  const bindings = nvimKeymapBindings([{ lhs: '<Space>ff' }], 'editor', 'normal', (lhs) =>
    sent.push(lhs)
  )
  bindings[0].run()
  expect(sent).toEqual(['<Space>ff'])
})

test('which-key groups become names for grove leader prefixes', () => {
  const labels = nvimGroupLabels([
    { lhs: ' c', name: 'code' },
    { lhs: ' gh', name: '+hunks' },
    { lhs: 'g', name: 'goto' }
  ])
  expect([...labels.entries()]).toEqual([
    ['<Leader> c', 'code'],
    ['<Leader> g h', 'hunks']
  ])
})

test('bindings are filed under the group of their first key, else Neovim', () => {
  const labels = nvimGroupLabels([{ lhs: ' g', name: 'git' }])
  const bindings = nvimKeymapBindings(
    [{ lhs: ' ghs', desc: 'Stage hunk' }, { lhs: ' tt', desc: 'Terminal' }],
    'editor',
    'visual',
    () => {},
    labels
  )
  expect(bindings.map((binding) => [binding.id, binding.group])).toEqual([
    ['nvim:<Leader> g h s', 'git'],
    ['nvim:<Leader> t t', 'Neovim']
  ])
})

test('a sequence mapped in normal and visual mode is one binding for both', () => {
  const bindings = nvimLeaderBindings(
    [{ lhs: ' ca', desc: 'Code action' }, { lhs: ' bb', desc: 'Other buffer' }],
    [{ lhs: ' ca', desc: 'Code action' }, { lhs: ' cf', desc: 'Format selection' }],
    'editor',
    () => {}
  )
  expect(bindings.map((binding) => [binding.keys, binding.mode])).toEqual([
    ['<Leader> c a', undefined],
    ['<Leader> b b', 'normal'],
    ['<Leader> c f', 'visual']
  ])
})
