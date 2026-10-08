// Builds every built-in plugin: the worker bundle (resources/plugins/*/src/
// extension.ts → dist/extension.js) and its pages (resources/plugins/*/pages/
// *.html → dist/pages/), the latter with the same Vite config any plugin
// author gets from '@grove/plugin-sdk/vite' — Svelte, @neoworks-dev/ui,
// Tailwind. The @grove/plugin-sdk worker shim is bundled in (it only forwards
// to globalThis.__grove, so bundles stay host-agnostic).
// Run with: bun scripts/build-plugins.ts [--watch]
//
// --watch builds everything, then rebuilds a plugin whenever a file in it
// changes outside dist/. In development Grove watches dist/ and reloads the
// plugin (scripts/dev.ts runs this alongside electron-vite).

import { watch } from 'fs'
import { readdir } from 'fs/promises'
import { join, sep } from 'path'
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

/** Builds one plugin: its worker, then its pages if the worker built. */
async function buildPlugin(dir: string): Promise<void> {
  if (await buildWorker(dir)) await buildPages(dir)
}

// A save often touches several files; wait for them before rebuilding.
const SETTLE_MS = 150

/**
 * Rebuilds a plugin when anything in it changes outside its build output.
 * Builds of one plugin run one after another; a change during a build queues
 * exactly one more.
 */
function watchPlugin(dir: string): void {
  const root = join(pluginsRoot, dir)
  let timer: Timer | null = null
  let running: Promise<void> | null = null
  let queued = false

  const rebuild = async (): Promise<void> => {
    if (running) {
      queued = true
      return
    }
    running = buildPlugin(dir)
    await running
    running = null
    if (!queued) return
    queued = false
    void rebuild()
  }

  watch(root, { recursive: true }, (_event, file) => {
    if (!file || isBuildOutput(file)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), SETTLE_MS)
  })
}

/** Whether a path inside a plugin is its build output or installed packages, which never trigger a build. */
function isBuildOutput(file: string): boolean {
  const top = file.split(sep)[0]
  return top === 'dist' || top === 'node_modules'
}

const watchMode = process.argv.includes('--watch')
const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch(() => [])
const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
for (const dir of dirs) await buildPlugin(dir)
if (watchMode) {
  for (const dir of dirs) watchPlugin(dir)
  console.log('watching plugins for changes')
}
