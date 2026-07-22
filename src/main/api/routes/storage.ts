// storage.* routes: client-scoped persisted key/value storage. Sections are
// keyed by client.key ('plugin:<id>' / 'app:<id>') so kinds can't collide;
// legacy sections keyed by bare plugin id are read as fallback and migrated
// on the next write.

import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { ClientRecord } from '../clients'
import type { RouteRegistry } from '../registry'

interface StorageDeps {
  storagePath: () => string
}

type StorageFile = Record<string, Record<string, unknown>>

export function registerStorageRoutes(registry: RouteRegistry, deps: StorageDeps): void {
  const readAll = async (): Promise<StorageFile> => {
    try {
      return JSON.parse(await readFile(deps.storagePath(), 'utf8'))
    } catch {
      return {}
    }
  }

  const writeAll = async (storage: StorageFile): Promise<void> => {
    await mkdir(dirname(deps.storagePath()), { recursive: true })
    await writeFile(deps.storagePath(), JSON.stringify(storage, null, 2), 'utf8')
  }

  const legacyKey = (client: ClientRecord): string | null => {
    if (client.kind !== 'plugin') return null
    return client.id
  }

  const sectionOf = (storage: StorageFile, client: ClientRecord): Record<string, unknown> => {
    const current = storage[client.key]
    if (current) return current
    const legacy = legacyKey(client)
    if (legacy && storage[legacy]) return storage[legacy]
    return {}
  }

  const persistSection = async (
    storage: StorageFile,
    client: ClientRecord,
    section: Record<string, unknown>
  ): Promise<void> => {
    storage[client.key] = section
    const legacy = legacyKey(client)
    if (legacy && legacy !== client.key) delete storage[legacy]
    await writeAll(storage)
  }

  registry.register({
    method: 'storage.get',
    scope: 'state',
    describe: () => 'read plugin storage',
    handler: async (args, context) => {
      const storage = await readAll()
      return sectionOf(storage, context.client)[String(args.key ?? '')]
    }
  })

  registry.register({
    method: 'storage.set',
    scope: 'state',
    describe: () => 'write plugin storage',
    handler: async (args, context) => {
      const storage = await readAll()
      const section = sectionOf(storage, context.client)
      section[String(args.key ?? '')] = args.value
      await persistSection(storage, context.client, section)
    }
  })

  registry.register({
    method: 'storage.delete',
    scope: 'state',
    describe: () => 'write plugin storage',
    handler: async (args, context) => {
      const storage = await readAll()
      const section = sectionOf(storage, context.client)
      delete section[String(args.key ?? '')]
      await persistSection(storage, context.client, section)
    }
  })
}
