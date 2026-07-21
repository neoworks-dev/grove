import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PermissionBroker } from '../src/main/api/broker'
import type { ClientRecord } from '../src/main/api/clients'

let dir: string
let grantsPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-grants-'))
  grantsPath = join(dir, 'plugin-grants.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function broker(): PermissionBroker {
  return new PermissionBroker({ onPermissionRequest: () => {} }, { grantsPath })
}

function client(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    key: 'plugin:test.plugin',
    kind: 'plugin',
    id: 'test.plugin',
    name: 'Test Plugin',
    source: 'user',
    declaredScopes: ['workspace.read', 'git.read'],
    ...overrides
  }
}

async function seed(store: unknown): Promise<void> {
  await writeFile(grantsPath, JSON.stringify(store), 'utf8')
}

describe('PermissionBroker grants review', () => {
  it('lists declared scopes merged with stored decisions', async () => {
    await seed({
      plugins: {
        'test.plugin': { permissions: { 'workspace.read': 'granted' }, fsScopes: ['/etc'] }
      }
    })
    const summaries = await broker().listGrants([client()])
    expect(summaries).toHaveLength(1)
    expect(summaries[0].clientId).toBe('test.plugin')
    expect(summaries[0].declared).toEqual(['workspace.read', 'git.read'])
    expect(summaries[0].permissions['workspace.read']).toBe('granted')
    expect(summaries[0].fsScopes).toEqual(['/etc'])
  })

  it('includes stored grants for clients that no longer exist', async () => {
    await seed({
      plugins: { 'gone.plugin': { permissions: { state: 'granted' }, fsScopes: [] } }
    })
    const summaries = await broker().listGrants([])
    expect(summaries).toHaveLength(1)
    expect(summaries[0].clientId).toBe('gone.plugin')
    expect(summaries[0].declared).toEqual([])
    expect(summaries[0].kind).toBe('plugin')
  })

  it('classifies app-prefixed sections as external apps', async () => {
    await seed({
      plugins: { 'app:my-cli': { permissions: { 'git.read': 'granted' }, fsScopes: [] } }
    })
    const summaries = await broker().listGrants([])
    expect(summaries[0].kind).toBe('app')
  })

  it('revoke deletes only the one decision and persists', async () => {
    await seed({
      plugins: {
        'test.plugin': {
          permissions: { 'workspace.read': 'granted', 'git.read': 'denied' },
          fsScopes: []
        }
      }
    })
    const instance = broker()
    await instance.revoke('test.plugin', 'workspace.read')
    const onDisk = JSON.parse(await readFile(grantsPath, 'utf8'))
    expect(onDisk.plugins['test.plugin'].permissions['workspace.read']).toBeUndefined()
    expect(onDisk.plugins['test.plugin'].permissions['git.read']).toBe('denied')
  })

  it('revokeFsScope removes only the matching path', async () => {
    await seed({
      plugins: { 'test.plugin': { permissions: {}, fsScopes: ['/etc', '/opt'] } }
    })
    const instance = broker()
    await instance.revokeFsScope('test.plugin', '/etc')
    const onDisk = JSON.parse(await readFile(grantsPath, 'utf8'))
    expect(onDisk.plugins['test.plugin'].fsScopes).toEqual(['/opt'])
  })

  it('revokeAll drops the whole section', async () => {
    await seed({
      plugins: { 'test.plugin': { permissions: { state: 'granted' }, fsScopes: ['/etc'] } }
    })
    const instance = broker()
    await instance.revokeAll('test.plugin')
    const onDisk = JSON.parse(await readFile(grantsPath, 'utf8'))
    expect(onDisk.plugins['test.plugin']).toBeUndefined()
  })

  it('revoke on an unknown client is a no-op', async () => {
    const instance = broker()
    await instance.revoke('missing.plugin', 'state')
    const summaries = await instance.listGrants([])
    expect(summaries).toEqual([])
  })

  it('ensure honors a revoked decision by prompting again', async () => {
    await seed({
      plugins: { 'test.plugin': { permissions: { 'workspace.read': 'granted' }, fsScopes: [] } }
    })
    let prompted = 0
    const instance = new PermissionBroker(
      {
        onPermissionRequest: (request) => {
          prompted += 1
          instance.respondPermission(request.id, 'allow-once')
        }
      },
      { grantsPath }
    )
    await instance.ensure(client(), 'workspace.read', 'test')
    expect(prompted).toBe(0)
    await instance.revoke('test.plugin', 'workspace.read')
    await instance.ensure(client(), 'workspace.read', 'test')
    expect(prompted).toBe(1)
  })
})
