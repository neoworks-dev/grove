// The sidecar as the Rust host runs it: a real `bun` child speaking frames over its pipes.
// It opens a throwaway repository, lists its files, hears a pushed watcher event, and
// leaves by itself when the host closes its stdin.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameDecoder, encodeFrame } from '../sdk/src/frames'
import type { RpcMessage } from '../sdk/src/protocol'

const ENTRY = join(import.meta.dir, '..', 'src', 'main', 'sidecar', 'index.ts')

let workDirectory = ''
let repository = ''
let child: ChildProcessWithoutNullStreams
const received: RpcMessage[] = []
let nextId = 1

/** Runs git with a fixed identity, so the repository commits anywhere. */
function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
    cwd: repository,
    stdio: 'ignore'
  })
}

/** Waits for the frame `match` accepts, whether it arrived already or comes later. */
async function frame(
  match: (message: RpcMessage) => boolean,
  timeoutMs = 20_000
): Promise<RpcMessage> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = received.find(match)
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the sidecar sent no such frame in time')
}

/** Calls a route over the pipe and resolves to the result, or throws the route's error. */
async function call(method: string, ...args: unknown[]): Promise<unknown> {
  const id = nextId
  nextId += 2
  child.stdin.write(encodeFrame({ kind: 'request', id, method, params: args }))
  const reply = await frame((message) => message.kind === 'response' && message.id === id)
  if (reply.kind === 'response' && reply.error) {
    throw new Error(reply.error.message)
  }
  return reply.kind === 'response' ? reply.result : undefined
}

beforeAll(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'grove-sidecar-'))
  repository = join(workDirectory, 'repo')
  mkdirSync(join(repository, 'src'), { recursive: true })
  writeFileSync(join(repository, 'README.md'), '# demo\n')
  git('init', '-q', '-b', 'trunk')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')

  child = spawn('bun', [ENTRY], {
    env: { ...process.env, GROVE_SIDECAR_DATA: join(workDirectory, 'data') },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const decoder = new FrameDecoder()
  child.stdout.on('data', (chunk: Buffer) => received.push(...decoder.push(chunk)))
  child.stderr.resume()
})

afterAll(() => {
  child.kill()
  rmSync(workDirectory, { recursive: true, force: true })
})

describe('sidecar process', () => {
  test('serves the routes the Electron app serves', async () => {
    const info = (await call('sidecar.info')) as { channels: string[] }
    expect(info.channels).toContain('git:branchStatus')
    expect(info.channels).toContain('files:listDir')
    expect(info.channels).toContain('repo:open')
  }, 30_000)

  test('opens a repository and lists its files and branch', async () => {
    const opened = (await call('repo:open', repository)) as {
      info: { currentBranch: string }
      worktrees: { id: string; path: string }[]
    }
    expect(opened.info.currentBranch).toBe('trunk')
    const worktree = opened.worktrees.find((entry) => entry.path.endsWith('/repo'))
    expect(worktree).toBeDefined()
    const files = (await call('files:listDir', worktree?.id, '')) as { name: string }[]
    expect(files.map((file) => file.name).sort()).toEqual(['README.md', 'src'])
  }, 30_000)

  test('pushes a watcher event when a watched file appears', async () => {
    const opened = (await call('repo:last')) as string
    expect(opened).toBe(repository)
    await call('fs:watch', [repository])
    // Give the watcher a moment to finish its first scan before the file lands.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    writeFileSync(join(repository, 'pushed.txt'), 'hello\n')
    const event = await frame(
      (message) =>
        message.kind === 'event' &&
        message.channel === 'event:fs-change' &&
        (message.payload as { relPath: string }).relPath === 'pushed.txt'
    )
    expect(event).toMatchObject({ payload: { type: 'add' } })
  }, 30_000)

  test('a route that fails answers with the error, and an unknown one says so', async () => {
    await expect(call('repo:open', join(workDirectory, 'nowhere'))).rejects.toThrow()
    await expect(call('no:such')).rejects.toThrow("No handler registered for 'no:such'")
  }, 30_000)

  test('leaves when the host closes its stdin', async () => {
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    child.stdin.end()
    expect(await exited).toBe(0)
  }, 30_000)
})
