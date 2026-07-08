// Builds every built-in plugin's worker bundle: resources/plugins/*/src/
// extension.ts → dist/extension.js. The @grove/plugin-sdk shim is bundled in
// (it only forwards to globalThis.__grove, so bundles stay host-agnostic).
// Run with: bun scripts/build-plugins.ts

import { readdir } from 'fs/promises'
import { join } from 'path'

const pluginsRoot = join(import.meta.dir, '..', 'resources', 'plugins')
const sdkEntry = join(import.meta.dir, '..', 'sdk', 'src', 'index.ts')

// Resolve the SDK from the repo directly — plugin dirs have no node_modules.
const sdkAlias = {
  name: 'grove-sdk-alias',
  setup(build: Bun.PluginBuilder): void {
    build.onResolve({ filter: /^@grove\/plugin-sdk$/ }, () => ({ path: sdkEntry }))
  }
}

async function buildPlugin(dir: string): Promise<void> {
  const entry = join(pluginsRoot, dir, 'src', 'extension.ts')
  const outdir = join(pluginsRoot, dir, 'dist')
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: 'browser',
    format: 'esm',
    naming: 'extension.js',
    plugins: [sdkAlias]
  })
  if (!result.success) {
    console.error(`build failed for ${dir}:`)
    for (const log of result.logs) console.error(log)
    process.exitCode = 1
    return
  }
  console.log(`built ${dir}/dist/extension.js`)
}

const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch(() => [])
for (const entry of entries) {
  if (entry.isDirectory()) await buildPlugin(entry.name)
}
