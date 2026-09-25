import { expect, test } from 'bun:test'
import { stripEntries, type StripEntry, type StripTab } from '../src/renderer/src/lib/nvim/splitTabs'

/** A tab for a file under /repo. */
function tab(name: string): StripTab {
  return { path: `/repo/${name}`, name }
}

/** The strip as text: split tabs as `a | b`, plain tabs by name. */
function describe(entries: StripEntry<StripTab>[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === 'tab') return entry.tab.name
    return entry.segments.map((segment) => segment.tab.name).join(' | ')
  })
}

const tabs = [tab('a.ts'), tab('b.ts'), tab('c.ts'), tab('d.ts')]

test('one window leaves the strip as it is', () => {
  expect(describe(stripEntries(tabs, [{ win: 1000, path: '/repo/b.ts' }]))).toEqual([
    'a.ts',
    'b.ts',
    'c.ts',
    'd.ts'
  ])
})

test('split files fold into one tab, in window order, where the first of them stood', () => {
  const splits = [
    { win: 1000, path: '/repo/d.ts' },
    { win: 1001, path: '/repo/b.ts' }
  ]
  expect(describe(stripEntries(tabs, splits))).toEqual(['a.ts', 'd.ts | b.ts', 'c.ts'])
})

test('one file in two splits shows twice', () => {
  const splits = [
    { win: 1000, path: '/repo/a.ts' },
    { win: 1001, path: '/repo/a.ts' }
  ]
  expect(describe(stripEntries(tabs, splits))).toEqual(['a.ts | a.ts', 'b.ts', 'c.ts', 'd.ts'])
})

test('a split file without a tab yet still gets its segment', () => {
  const splits = [
    { win: 1000, path: '/repo/a.ts' },
    { win: 1001, path: '/elsewhere/new.ts' }
  ]
  expect(describe(stripEntries(tabs, splits))).toEqual(['a.ts | new.ts', 'b.ts', 'c.ts', 'd.ts'])
})
