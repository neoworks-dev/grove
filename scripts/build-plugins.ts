// Builds every built-in plugin: the worker bundle (resources/plugins/*/src/
// extension.ts → dist/extension.js) and its pages (resources/plugins/*/pages/
// *.html → dist/pages/), the latter with the same Vite config any plugin
// author gets from '@grove/plugin-sdk/vite' — Svelte, @neoworks-dev/ui,
// Tailwind. The @grove/plugin-sdk worker shim is bundled in (it only forwards
// to globalThis.__grove, so bundles stay host-agnostic).
// Run with: bun scripts/build-plugins.ts

import { readdir } from 'fs/promises'
import { join } from 'path'
import { build } from 'vite'
import { pageBuildConfig } from '../sdk/src/vite'

const pluginsRoot = join(import.meta.dir, '..', 'resources', 'plugins')
const sdkEntry = join(import.meta.dir, '..', 'sdk', 'src', 'index.ts')

// Resolve the SDK from the repo directly — plugin dirs have no node_modules.
const sdkAlias = {
  name: 'grove-sdk-alias',
  setup(builder: Bun.PluginBuilder): void {
    builder.onResolve({ filter: /^@grove\/plugin-sdk$/ }, () => ({ path: sdkEntry }))
  }
}

/** Bundles a plugin's worker entry; false when it failed. */
async function buildWorker(dir: string): Promise<boolean> {
  const root = join(pluginsRoot, dir)
  const result = await Bun.build({
    entrypoints: [join(root, 'src', 'extension.ts')],
    outdir: join(root, 'dist'),
    target: 'browser',
    format: 'esm',
    naming: 'extension.js',
    plugins: [sdkAlias]
  })
  if (result.success) {
    console.log(`built ${dir}/dist/extension.js`)
    return true
  }
  console.error(`worker build failed for ${dir}:`)
  for (const log of result.logs) console.error(log)
  process.exitCode = 1
  return false
}

/** Builds a plugin's pages, when it has any. */
async function buildPages(dir: string): Promise<void> {
  const config = pageBuildConfig(join(pluginsRoot, dir))
  if (!config) return
  try {
    await build(config)
    console.log(`built ${dir}/dist/pages/`)
  } catch (error) {
    console.error(`page build failed for ${dir}:`, error)
    process.exitCode = 1
  }
}

const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch(() => [])
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  if (await buildWorker(entry.name)) await buildPages(entry.name)
}
