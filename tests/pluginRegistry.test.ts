// The registry is reloaded when a repository opens, while the plugins it
// already listed are importing their bundles through grove-plugin://. A reload
// must never leave a gap in which a ready plugin is missing, or its import
// fails with "Failed to fetch dynamically imported module".

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { appStub, electronStub } from './electronStub'
import type { PermissionBroker } from '../src/main/api/broker'

mock.module('electron', () => electronStub)

const { PluginRegistry } = await import('../src/main/plugins/loader')

let root = ''

/** Writes a minimal valid plugin manifest into a plugins root. */
async function writePlugin(pluginsRoot: string, id: string): Promise<void> {
  const dir = join(pluginsRoot, id)
  await mkdir(dir, { recursive: true })
  const manifest = { id, name: id, version: '1.0.0', entry: 'dist/extension.js' }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
}

/** A broker that enables and trusts everything. */
const trustingBroker = {
  isEnabled: async () => true,
  isProjectPluginTrusted: async () => true
} as unknown as PermissionBroker

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grove-plugin-registry-'))
  appStub.getAppPath = () => join(root, 'app')
  appStub.getPath = () => join(root, 'userData')
  await writePlugin(join(root, 'app', 'resources', 'plugins'), 'grove.harpoon')
  await writePlugin(join(root, 'repo', '.workbench', 'plugins'), 'project.tool')
})

afterEach(async () => {
  appStub.getAppPath = () => process.cwd()
  appStub.getPath = () => process.cwd()
  await rm(root, { recursive: true, force: true })
})

describe('PluginRegistry.loadAll', () => {
  it('keeps serving loaded plugins while a reload is under way', async () => {
    const registry = new PluginRegistry(trustingBroker)
    await registry.loadAll(null)

    const reload = registry.loadAll(join(root, 'repo'))
    const duringReload = registry.get('grove.harpoon')
    await reload

    expect(duringReload?.status).toBe('ready')
    expect(registry.get('project.tool')?.status).toBe('ready')
  })

  it('ends on the last load asked for, whichever finishes first', async () => {
    const registry = new PluginRegistry(trustingBroker)

    const boot = registry.loadAll(null)
    const repoOpened = registry.loadAll(join(root, 'repo'))
    await Promise.all([boot, repoOpened])

    expect(registry.list().map((record) => record.id).sort()).toEqual([
      'grove.harpoon',
      'project.tool'
    ])
  })
})
