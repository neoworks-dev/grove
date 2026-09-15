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
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })],
    build: {
      rollupOptions: {
        // The terminal daemon is its own process: grove spawns it detached so
        // the shells it owns survive the app quitting. It ships as a second
        // chunk beside the main bundle and runs on Electron's node runtime.
        input: {
          index: 'src/main/index.ts',
          terminalDaemon: 'src/main/terminalDaemon.ts'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })]
  },
  renderer: {
    plugins: [tailwindcss(), svelte()]
  }
})
