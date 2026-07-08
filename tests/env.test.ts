import { describe, it, expect } from 'bun:test'
import { buildWorktreeEnv, substitute } from '../src/main/env'
import type { Worktree } from '../src/shared/types'

const worktree: Worktree = {
  id: '/repo/.worktrees/feature',
  name: 'feature',
  path: '/repo/.worktrees/feature',
  branch: 'feature-x',
  isMain: false,
  isDetached: false,
  locked: false,
  dirty: false,
  portSlot: 1
}

describe('buildWorktreeEnv', () => {
  it('exposes WT_* and PORT_n variables', () => {
    const env = buildWorktreeEnv(worktree, [3110, 3111, 3112])
    expect(env.WT_ID).toBe(worktree.id)
    expect(env.WT_NAME).toBe('feature')
    expect(env.WT_PATH).toBe(worktree.path)
    expect(env.WT_BRANCH).toBe('feature-x')
    expect(env.PORT_0).toBe('3110')
    expect(env.PORT_1).toBe('3111')
    expect(env.PORT_2).toBe('3112')
  })
})

describe('substitute', () => {
  const vars = { PORT_0: '3110', PORT_1: '3111', WT_NAME: 'feature' }

  it('replaces ${VAR} form', () => {
    expect(substitute('bun dev --port ${PORT_0}', vars)).toBe('bun dev --port 3110')
  })

  it('replaces $VAR form', () => {
    expect(substitute('http://localhost:$PORT_1', vars)).toBe('http://localhost:3111')
  })

  it('handles multiple substitutions', () => {
    expect(substitute('${WT_NAME}:${PORT_0}:${PORT_1}', vars)).toBe('feature:3110:3111')
  })

  it('leaves unknown variables untouched', () => {
    expect(substitute('echo ${HOME}/${PORT_0}', vars)).toBe('echo ${HOME}/3110')
  })
})
