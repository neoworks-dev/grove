// Building a plugin's pages: the Vite config Grove builds its own plugins'
// pages with, for any plugin to use. Pages are Svelte with @neoworks-dev/ui,
// styled from '@grove/plugin-sdk/page.css' — the same toolchain as Grove's
// renderer (Svelte 5, Tailwind v4), so a page is written like a Grove pane.
//
//   import { build } from 'vite'
//   import { pageBuildConfig } from '@grove/plugin-sdk/vite'
//   const config = pageBuildConfig(pluginRoot)
//   if (config) await build(config)
//
// Every `pages/*.html` under the plugin root is an entry; each lands in
// `dist/pages/` beside its bundled script and styles, so a manifest names it
// as `"page": "dist/pages/<name>.html"`.

import { readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import type { InlineConfig, Plugin } from 'vite'

const sdkSource = dirname(fileURLToPath(import.meta.url))

/** The HTML pages a plugin ships, as paths under its root; empty when it has none. */
export function pageEntries(pluginRoot: string): string[] {
  const pagesDir = join(pluginRoot, 'pages')
  let names: string[] = []
  try {
    names = readdirSync(pagesDir)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith('.html')).map((name) => join(pagesDir, name))
}

/** The Vite config that builds a plugin's pages into `dist/pages`, or null when it has none. */
export function pageBuildConfig(pluginRoot: string): InlineConfig | null {
  const entries = pageEntries(pluginRoot)
  if (entries.length === 0) return null
  return {
    root: pluginRoot,
    // Pages load from grove-plugin://<id>/dist/pages/…; every URL stays relative.
    base: './',
    configFile: false,
    logLevel: 'warn',
    plugins: [cleanPageOutput(pluginRoot), tailwindcss(), svelte({ configFile: false })],
    resolve: {
      alias: sdkAliases(),
      // One copy of each, whatever path a linked package resolves them from.
      dedupe: ['svelte', 'phosphor-svelte']
    },
    build: {
      outDir: join(pluginRoot, 'dist'),
      // The worker bundle lives in dist/ too.
      emptyOutDir: false,
      // The page's policy allows its own scripts only; no inline preload shim.
      modulePreload: false,
      rollupOptions: { input: entries }
    }
  }
}

/**
 * Clears what the last page build left, before this one writes: `dist/` also
 * holds the worker bundle, so it can't be emptied whole, and hashed asset names
 * would otherwise pile up build after build.
 */
function cleanPageOutput(pluginRoot: string): Plugin {
  return {
    name: 'grove-clean-page-output',
    apply: 'build',
    buildStart() {
      for (const dir of ['pages', 'assets']) {
        rmSync(join(pluginRoot, 'dist', dir), { recursive: true, force: true })
      }
    }
  }
}

/** '@grove/plugin-sdk/<name>' straight to this package's sources. */
function sdkAliases(): { find: RegExp; replacement: string }[] {
  return [
    { find: /^@grove\/plugin-sdk\/page\.css$/, replacement: join(sdkSource, 'page.css') },
    { find: /^@grove\/plugin-sdk\/([a-z]+)$/, replacement: join(sdkSource, '$1.ts') }
  ]
}
