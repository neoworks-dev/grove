// Debug adapters are found, not listed: plugins register descriptors, Mason's
// own registry says which DAP packages exist, and an installed one nobody
// describes still gets a generic descriptor. Executables are looked up in the
// directories the registry is given, Mason's bin first.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DebugAdapterRegistry,
  genericMasonDescriptor,
  type DebugAdapterDescriptor
} from '../src/main/debug/registry'
import {
  debugEntriesOf,
  masonPackageInstalled,
  readMasonDebugCatalog
} from '../src/main/debug/mason'
import { debugpy, projectInterpreter } from '../src/main/debug/adapters/python'
import { jsDebug } from '../src/main/debug/adapters/javascript'

const REGISTRY = JSON.stringify([
  {
    name: 'debugpy',
    categories: ['DAP'],
    languages: ['Python'],
    bin: { debugpy: 'x', 'debugpy-adapter': 'y' }
  },
  {
    name: 'bash-debug-adapter',
    categories: ['DAP'],
    languages: ['Bash'],
    bin: { 'bash-debug-adapter': 'z' }
  },
  { name: 'cortex-debug', categories: ['DAP'], languages: ['C'], bin: null },
  { name: 'vtsls', categories: ['LSP'], languages: ['TypeScript'], bin: { vtsls: 'v' } }
])

let mason: string

beforeAll(() => {
  mason = mkdtempSync(join(tmpdir(), 'grove-mason-'))
  const registryDirectory = join(mason, 'registries', 'github', 'mason-org', 'mason-registry')
  mkdirSync(registryDirectory, { recursive: true })
  writeFileSync(join(registryDirectory, 'registry.json'), REGISTRY)
  mkdirSync(join(mason, 'packages', 'bash-debug-adapter'), { recursive: true })
  mkdirSync(join(mason, 'bin'))
  writeFileSync(join(mason, 'bin', 'bash-debug-adapter'), '#!/bin/sh\n')
  chmodSync(join(mason, 'bin', 'bash-debug-adapter'), 0o755)
})

afterAll(() => {
  rmSync(mason, { recursive: true, force: true })
})

describe("Mason's catalog", () => {
  test('keeps the DAP packages with their languages and executables', () => {
    expect(debugEntriesOf(REGISTRY)).toEqual([
      { name: 'debugpy', languages: ['Python'], bins: ['debugpy', 'debugpy-adapter'] },
      { name: 'bash-debug-adapter', languages: ['Bash'], bins: ['bash-debug-adapter'] },
      { name: 'cortex-debug', languages: ['C'], bins: [] }
    ])
    expect(debugEntriesOf('not json')).toEqual([])
  })

  test('is read from wherever Mason keeps its registries', async () => {
    const catalog = await readMasonDebugCatalog(mason)
    expect(catalog.map((entry) => entry.name)).toEqual([
      'debugpy',
      'bash-debug-adapter',
      'cortex-debug'
    ])
    expect(masonPackageInstalled(mason, 'bash-debug-adapter')).toBe(true)
    expect(masonPackageInstalled(mason, 'debugpy')).toBe(false)
    expect(await readMasonDebugCatalog(join(mason, 'missing'))).toEqual([])
  })
})

describe('DebugAdapterRegistry', () => {
  test('resolves a type to the descriptor serving it, registered or from Mason', async () => {
    const registry = new DebugAdapterRegistry(() => [join(mason, 'bin')])
    const unregister = registry.register(debugpy)
    registry.register(jsDebug)
    registry.setMasonCatalog(await readMasonDebugCatalog(mason))

    expect(registry.forType('python')?.id).toBe('debugpy')
    expect(registry.forType('node')?.id).toBe('js-debug')
    const generic = registry.forType('bash-debug-adapter')
    expect(generic?.id).toBe('mason:bash-debug-adapter')
    if (!generic) throw new Error('no generic descriptor')
    expect(registry.resolve(generic).executablePath).toBe(join(mason, 'bin', 'bash-debug-adapter'))
    expect(registry.resolve(debugpy).executablePath).toBeNull()
    // A package with no executable cannot be started, so it gets no descriptor.
    expect(registry.forType('cortex-debug')).toBeNull()
    // debugpy's own descriptor wins over a generic one for its package.
    expect(
      registry.list().filter((descriptor) => descriptor.masonPackage === 'debugpy')
    ).toHaveLength(1)

    unregister()
    expect(registry.forType('python')).toBeNull()
    expect(() => registry.register(jsDebug)).toThrow('already registered')
  })

  test('describes each adapter with where it was found and whether it is installing', () => {
    const registry = new DebugAdapterRegistry(() => [join(mason, 'bin')])
    registry.register(debugpy)
    const [info] = registry.describe(new Set(['debugpy']))
    expect(info).toMatchObject({
      id: 'debugpy',
      executable: null,
      masonPackage: 'debugpy',
      installing: true
    })
  })

  test('a generic descriptor runs the first executable over stdio', () => {
    const descriptor = genericMasonDescriptor({
      name: 'x-dap',
      languages: [],
      bins: ['x-dap', 'other']
    })
    expect(descriptor.types).toEqual(['x-dap'])
    expect(descriptor.launch('/bin/x-dap', 0)).toEqual({
      kind: 'stdio',
      command: '/bin/x-dap',
      args: []
    })
  })
})

/** Runs a descriptor's resolveConfiguration, which these descriptors all have. */
function resolveWith(
  descriptor: DebugAdapterDescriptor,
  configuration: Record<string, unknown>,
  context: { worktreePath: string; env: NodeJS.ProcessEnv }
): Record<string, unknown> {
  if (!descriptor.resolveConfiguration) {
    throw new Error(`${descriptor.id} has no resolveConfiguration`)
  }
  return descriptor.resolveConfiguration(configuration, context)
}

describe('adapter descriptors', () => {
  test("debugpy runs the project's virtualenv, not Mason's", () => {
    const worktree = mkdtempSync(join(tmpdir(), 'grove-venv-'))
    try {
      expect(projectInterpreter({ worktreePath: worktree, env: {} })).toBe('python3')
      mkdirSync(join(worktree, '.venv', 'bin'), { recursive: true })
      writeFileSync(join(worktree, '.venv', 'bin', 'python'), '')
      const resolved = resolveWith(
        debugpy,
        { type: 'python', program: 'x.py' },
        { worktreePath: worktree, env: {} }
      )
      expect(resolved).toEqual({
        type: 'debugpy',
        program: 'x.py',
        python: join(worktree, '.venv', 'bin', 'python')
      })
      const explicit = resolveWith(
        debugpy,
        { type: 'debugpy', python: '/usr/bin/python3.12' },
        { worktreePath: worktree, env: {} }
      )
      expect(explicit.python).toBe('/usr/bin/python3.12')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  test("js-debug takes launch.json's old type names under its own", () => {
    expect(resolveWith(jsDebug, { type: 'node' }, { worktreePath: '/', env: {} }).type).toBe(
      'pwa-node'
    )
    expect(resolveWith(jsDebug, { type: 'pwa-chrome' }, { worktreePath: '/', env: {} }).type).toBe(
      'pwa-chrome'
    )
    expect(jsDebug.launch('/m/js-debug-adapter', 4711)).toEqual({
      kind: 'server',
      command: '/m/js-debug-adapter',
      args: ['4711', '127.0.0.1'],
      host: '127.0.0.1',
      port: 4711
    })
  })
})
