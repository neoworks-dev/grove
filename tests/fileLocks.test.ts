import { describe, it, expect } from 'bun:test'
import { FileLockManager } from '../src/main/agents/locks'

const A = 'wt1::claude'
const B = 'wt1::codex'

describe('FileLockManager', () => {
  it('grants a free file and blocks a second owner', () => {
    const locks = new FileLockManager()
    expect(locks.tryAcquire(A, 'claude', ['/wt/a.ts'])).toEqual({ ok: true })
    const blocked = locks.tryAcquire(B, 'codex', ['/wt/a.ts'])
    expect(blocked.ok).toBe(false)
    expect(blocked.heldBy).toBe('claude')
  })

  it('lets the same owner re-acquire its own lock', () => {
    const locks = new FileLockManager()
    locks.tryAcquire(A, 'claude', ['/wt/a.ts'])
    expect(locks.tryAcquire(A, 'claude', ['/wt/a.ts'])).toEqual({ ok: true })
  })

  it('is all-or-nothing: a partial conflict acquires nothing', () => {
    const locks = new FileLockManager()
    locks.tryAcquire(A, 'claude', ['/wt/a.ts'])
    const result = locks.tryAcquire(B, 'codex', ['/wt/b.ts', '/wt/a.ts'])
    expect(result.ok).toBe(false)
    // b.ts must remain free since the batch failed.
    expect(locks.tryAcquire('wt1::third', 'third', ['/wt/b.ts'])).toEqual({ ok: true })
  })

  it('frees files when the owner releases', () => {
    const locks = new FileLockManager()
    locks.tryAcquire(A, 'claude', ['/wt/a.ts', '/wt/b.ts'])
    locks.releaseOwner(A)
    expect(locks.tryAcquire(B, 'codex', ['/wt/a.ts'])).toEqual({ ok: true })
  })

  it('reclaims a stale lock after the timeout', () => {
    let clock = 1000
    const locks = new FileLockManager(() => clock)
    locks.tryAcquire(A, 'claude', ['/wt/a.ts'])
    // Just under 5 minutes: still held.
    clock += 5 * 60 * 1000 - 1
    expect(locks.tryAcquire(B, 'codex', ['/wt/a.ts']).ok).toBe(false)
    // Past the timeout: reclaimable.
    clock += 2
    expect(locks.tryAcquire(B, 'codex', ['/wt/a.ts']).ok).toBe(true)
  })

  it('reports held paths, excluding stale ones', () => {
    let clock = 0
    const locks = new FileLockManager(() => clock)
    locks.tryAcquire(A, 'claude', ['/wt/a.ts'])
    expect(locks.heldPaths()).toEqual([{ path: '/wt/a.ts', ownerName: 'claude' }])
    clock += 5 * 60 * 1000
    expect(locks.heldPaths()).toEqual([])
  })
})
