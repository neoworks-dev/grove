import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorktreeChannel, channelPathFor } from '../src/main/worktreeChannel'
import type { WorktreeChatMessage } from '../src/shared/types'

const roots: string[] = []

async function worktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grove-channel-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('WorktreeChannel', () => {
  it('stores messages per worktree and notifies once each', async () => {
    const seen: WorktreeChatMessage[] = []
    const channel = new WorktreeChannel({ onMessage: (message) => seen.push(message) })
    const one = await worktree()
    const two = await worktree()

    await channel.post(one, { kind: 'user', name: 'you' }, 'hello')
    await channel.post(one, { kind: 'agent', name: 'session-1' }, 'hi', 'you')
    await channel.post(two, { kind: 'user', name: 'you' }, 'other worktree')

    expect(seen).toHaveLength(3)
    expect((await channel.list(one)).map((message) => message.text)).toEqual(['hello', 'hi'])
    expect(await channel.list(two)).toHaveLength(1)
    expect((await channel.list(one))[1].to).toBe('you')
  })

  it('filters history by timestamp', async () => {
    let clock = 100
    const channel = new WorktreeChannel({ onMessage: () => {} }, () => clock)
    const root = await worktree()

    await channel.post(root, { kind: 'user', name: 'you' }, 'first')
    clock = 200
    await channel.post(root, { kind: 'user', name: 'you' }, 'second')

    expect((await channel.list(root, 150)).map((message) => message.text)).toEqual(['second'])
    expect(await channel.list(root, 0)).toHaveLength(2)
  })

  it('writes one JSON line per message, which is what the agent side reads', async () => {
    const channel = new WorktreeChannel({ onMessage: () => {} }, () => 42)
    const root = await worktree()
    await channel.post(root, { kind: 'user', name: 'you' }, 'hello')

    const lines = (await readFile(channelPathFor(root), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ text: 'hello', ts: 42 })
  })

  it('reads what the agent side appended, and skips a half-written line', async () => {
    const channel = new WorktreeChannel({ onMessage: () => {} })
    const root = await worktree()
    await mkdir(join(root, '.workbench'), { recursive: true })
    await writeFile(
      channelPathFor(root),
      [
        JSON.stringify({
          id: 'a',
          from: { kind: 'agent', name: 's1' },
          text: 'from the agent',
          ts: 1
        }),
        '{"id":"b","from":{"kind":"age',
        ''
      ].join('\n'),
      'utf8'
    )

    const messages = await channel.list(root)
    expect(messages.map((message) => message.text)).toEqual(['from the agent'])
    expect(messages[0].from.name).toBe('s1')
  })

  it('reports a worktree with no channel file as empty rather than failing', async () => {
    const channel = new WorktreeChannel({ onMessage: () => {} })
    expect(await channel.list(await worktree())).toEqual([])
  })
})
