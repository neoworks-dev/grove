import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { electronStub } from './electronStub'
import type { Worktree } from '../src/shared/types'

mock.module('electron', () => electronStub)

const { parseRange, registerFileProtocol } = await import('../src/main/fileProtocol')

type Handler = (request: Request) => Promise<Response>

describe('parseRange', () => {
  it('reads an open-ended range to the end of the file', () => {
    expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
  })

  it('clamps an end past the file to its last byte', () => {
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('reads a suffix range as the last bytes', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })

  it('rejects a range that starts past the end', () => {
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
  })

  it('rejects a malformed header', () => {
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
  })
})

describe('grove-file protocol', () => {
  let handler: Handler
  let root: string
  let outside: string
  const originalHandle = electronStub.protocol.handle

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'grove-file-'))
    outside = await mkdtemp(join(tmpdir(), 'grove-file-outside-'))
    await mkdir(join(root, 'art dir'))
    await writeFile(join(root, 'art dir', 'clip.mp4'), '0123456789')
    await writeFile(join(outside, 'secret.png'), 'secret')
    await symlink(join(outside, 'secret.png'), join(root, 'escape.png'))

    const worktree: Worktree = {
      id: root,
      name: 'grove-file',
      path: root,
      branch: 'main',
      isMain: true,
      isDetached: false,
      locked: false,
      dirty: false,
      portSlot: 0
    }
    electronStub.protocol.handle = (_scheme: string, registered: never): void => {
      handler = registered
    }
    registerFileProtocol((worktreeId) => {
      if (worktreeId !== worktree.id) throw new Error('unknown worktree')
      return worktree
    })
  })

  afterAll(() => {
    electronStub.protocol.handle = originalHandle
  })

  /** A grove-file:// URL for a path inside the test worktree. */
  function urlFor(relativePath: string): string {
    const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/')
    return `grove-file://worktree/${encodeURIComponent(root)}/${encodedPath}`
  }

  it('serves a whole file with its type', async () => {
    const response = await handler(new Request(urlFor('art dir/clip.mp4')))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(await response.text()).toBe('0123456789')
  })

  it('answers a range request with just that slice', async () => {
    const request = new Request(urlFor('art dir/clip.mp4'), { headers: { range: 'bytes=2-5' } })
    const response = await handler(request)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await response.text()).toBe('2345')
  })

  it('refuses an unsatisfiable range', async () => {
    const request = new Request(urlFor('art dir/clip.mp4'), { headers: { range: 'bytes=50-' } })
    const response = await handler(request)
    expect(response.status).toBe(416)
  })

  it('does not follow a symlink out of the worktree', async () => {
    const response = await handler(new Request(urlFor('escape.png')))
    expect(response.status).toBe(404)
  })

  it('does not climb out with dot segments', async () => {
    const escaped = `grove-file://worktree/${encodeURIComponent(root)}/..%2F${encodeURIComponent(outside.split('/').pop() ?? '')}%2Fsecret.png`
    const response = await handler(new Request(escaped))
    expect(response.status).toBe(404)
  })

  it('does not serve from an unknown worktree', async () => {
    const response = await handler(new Request('grove-file://worktree/nowhere/clip.mp4'))
    expect(response.status).toBe(404)
  })
})
