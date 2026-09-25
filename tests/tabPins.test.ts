import { describe, expect, it } from 'bun:test'
import { applyPins, pinnedPathsByWorktree } from '../src/renderer/src/lib/tabPins'

describe('pinnedPathsByWorktree', () => {
  it('lists the pinned file tabs of each worktree', () => {
    const pinned = pinnedPathsByWorktree({
      one: [{ path: '/a.ts', pinned: true }, { path: '/b.ts' }],
      two: [{ path: '/c.ts' }]
    })
    expect(pinned).toEqual({ one: ['/a.ts'] })
  })

  it('never persists a pinned scratch buffer', () => {
    const pinned = pinnedPathsByWorktree({
      one: [{ path: 'scratch://rename', pinned: true, scratch: true }]
    })
    expect(pinned).toEqual({})
  })
})

describe('applyPins', () => {
  it('pins the restored tabs whose paths were saved', () => {
    const tabs = applyPins([{ path: '/a.ts' }, { path: '/b.ts' }], ['/b.ts'])
    expect(tabs).toEqual([{ path: '/a.ts' }, { path: '/b.ts', pinned: true }])
  })

  it('survives a save and restore', () => {
    const saved = pinnedPathsByWorktree({
      one: [{ path: '/a.ts', pinned: true }, { path: '/b.ts' }]
    })
    const tabs: { path: string; pinned?: boolean }[] = [{ path: '/a.ts' }, { path: '/b.ts' }]
    const restored = applyPins(tabs, saved.one)
    expect(restored.map((tab) => tab.pinned === true)).toEqual([true, false])
  })
})
