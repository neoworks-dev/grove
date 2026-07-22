import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AppPairing, type AppPairingRequest } from '../src/main/api/socket/pairing'
import type { HelloParams } from '../src/shared/plugins'

let dir: string
let storePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-pairing-'))
  storePath = join(dir, 'external-apps.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function pairing(options: { approve?: boolean; timeoutMs?: number } = {}): {
  instance: AppPairing
  requests: AppPairingRequest[]
} {
  const requests: AppPairingRequest[] = []
  const approve = options.approve ?? true
  const instance = new AppPairing(
    {
      onPairingRequest: (request) => {
        requests.push(request)
        if (options.timeoutMs === undefined) {
          queueMicrotask(() => instance.respondPairing(request.id, approve))
        }
      }
    },
    { storePath, pairingTimeoutMs: options.timeoutMs }
  )
  return { instance, requests }
}

function hello(overrides: Partial<HelloParams> = {}): HelloParams {
  return {
    appId: 'my-cli',
    name: 'My CLI',
    version: '1.0.0',
    requestedScopes: ['workspace.read'],
    ...overrides
  }
}

describe('AppPairing', () => {
  it('pairs a new app and mints a token', async () => {
    const { instance, requests } = pairing()
    const { client, result } = await instance.hello(hello())
    expect(requests).toHaveLength(1)
    expect(result.token).toBeDefined()
    expect(result.grantedScopes).toEqual(['workspace.read'])
    expect(client.key).toBe('app:my-cli')
    expect(client.kind).toBe('app')
    expect(client.declaredScopes).toEqual(['workspace.read'])
    const onDisk = JSON.parse(await readFile(storePath, 'utf8'))
    expect(onDisk.apps['my-cli'].tokenHash).not.toBe(result.token)
  })

  it('reconnects with a valid token without prompting', async () => {
    const first = pairing()
    const initial = await first.instance.hello(hello())
    const second = pairing()
    const again = await second.instance.hello(hello({ token: initial.result.token }))
    expect(second.requests).toHaveLength(0)
    expect(again.result.token).toBeUndefined()
    expect(again.client.key).toBe('app:my-cli')
  })

  it('rejects a bad token by re-pairing (prompt) and denies when refused', async () => {
    const first = pairing()
    await first.instance.hello(hello())
    const second = pairing({ approve: false })
    const attempt = second.instance.hello(hello({ token: 'wrong-token' }))
    await expect(attempt).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(second.requests).toHaveLength(1)
  })

  it('scope escalation with a valid token re-prompts and merges scopes', async () => {
    const first = pairing()
    const initial = await first.instance.hello(hello())
    const second = pairing()
    const escalated = await second.instance.hello(
      hello({ token: initial.result.token, requestedScopes: ['workspace.read', 'git.read'] })
    )
    expect(second.requests).toHaveLength(1)
    expect(escalated.result.grantedScopes.sort()).toEqual(['git.read', 'workspace.read'])
    expect(escalated.result.token).toBeDefined()
  })

  it('times out unanswered pairing prompts', async () => {
    const { instance } = pairing({ timeoutMs: 20 })
    const attempt = instance.hello(hello())
    await expect(attempt).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('validates hello params', async () => {
    const { instance } = pairing()
    await expect(instance.hello(hello({ appId: 'Bad Id!' }))).rejects.toMatchObject({
      code: 'invalid'
    })
    await expect(
      instance.hello(hello({ requestedScopes: ['not-a-scope' as never] }))
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('revoke invalidates the token', async () => {
    const first = pairing()
    const initial = await first.instance.hello(hello())
    await first.instance.revoke('my-cli')
    const second = pairing({ approve: false })
    const attempt = second.instance.hello(hello({ token: initial.result.token }))
    await expect(attempt).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('lists paired apps without token hashes', async () => {
    const { instance } = pairing()
    await instance.hello(hello())
    const apps = await instance.list()
    expect(apps).toHaveLength(1)
    expect(apps[0].appId).toBe('my-cli')
    expect((apps[0] as Record<string, unknown>).tokenHash).toBeUndefined()
  })
})
