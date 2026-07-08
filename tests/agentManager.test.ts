import { describe, it, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentManager, type AgentEvents } from '../src/main/agents'
import type { Worktree } from '../src/shared/types'

function makeWorktree(path: string): Worktree {
  return {
    id: 'wt1',
    name: 'wt1',
    path,
    branch: 'main',
    isMain: true,
    isDetached: false,
    locked: false,
    dirty: false,
    portSlot: 0
  }
}

function noopEvents(overrides: Partial<AgentEvents> = {}): AgentEvents {
  return {
    onStatus: () => {},
    onLog: () => {},
    onPermission: () => {},
    ...overrides
  }
}

async function seedLog(worktreePath: string, name: string, lines: string[]): Promise<void> {
  const dir = join(worktreePath, '.workbench', 'logs')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `agent-${name}.log`), lines.join('\n') + '\n', 'utf8')
}

describe('AgentManager transcript + reset', () => {
  it('reads the persisted transcript, dropping blank lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-'))
    await seedLog(dir, 'claude', ['{"type":"user_prompt","text":"hi"}', '', '{"type":"assistant"}'])
    const manager = new AgentManager(noopEvents())
    const lines = await manager.readTranscript(dir, 'claude')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('user_prompt')
  })

  it('resetSession clears the token and truncates the transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-'))
    await seedLog(dir, 'claude', ['{"type":"assistant"}'])
    const sessionEvents: string[] = []
    const manager = new AgentManager(
      noopEvents({ onSession: (_wt, _name, token) => sessionEvents.push(token) })
    )
    manager.loadSessions({ 'wt1::claude': 'sess-123' })

    await manager.resetSession(makeWorktree(dir), 'claude')

    // Token cleared (empty-string notification) and log emptied.
    expect(sessionEvents).toContain('')
    const logText = await readFile(join(dir, '.workbench', 'logs', 'agent-claude.log'), 'utf8')
    expect(logText).toBe('')
    // A subsequent replay finds nothing.
    expect(await manager.readTranscript(dir, 'claude')).toHaveLength(0)
  })
})
