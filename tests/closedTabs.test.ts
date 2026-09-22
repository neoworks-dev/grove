// Which tab paths a tab-list change closed. Each one has its nvim buffer
// deleted, so a path reported here that is still open would close a live file.

import { describe, expect, test } from 'bun:test'
import { closedTabPaths } from '../src/renderer/src/lib/nvim/closedTabs'

describe('closedTabPaths', () => {
  test('reports paths that left the list', () => {
    expect(closedTabPaths(['/a.ts', '/b.ts', '/c.ts'], ['/a.ts', '/c.ts'])).toEqual(['/b.ts'])
  })

  test('ignores paths that were opened or reordered', () => {
    expect(closedTabPaths(['/a.ts', '/b.ts'], ['/b.ts', '/a.ts', '/new.ts'])).toEqual([])
  })

  test('reports every path when the list empties', () => {
    expect(closedTabPaths(['/a.ts', '/b.ts'], [])).toEqual(['/a.ts', '/b.ts'])
  })
})
