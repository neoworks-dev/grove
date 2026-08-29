import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// Externalize node deps so the agent SDKs (ESM-only, and they spawn their own
// CLIs/servers) load from node_modules at runtime via dynamic import() instead
// of being bundled into the CommonJS main chunk.
//
// The extension-system kernel is the exception: it ships ESM only with no CJS
// entry, so an externalized require() from the main chunk would fail. It has
// zero runtime dependencies, so bundling it in costs nothing.
const bundledDeps = ['@neoworks/extension-system']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })]
  },
  renderer: {
    plugins: [tailwindcss(), svelte()]
  }
})
