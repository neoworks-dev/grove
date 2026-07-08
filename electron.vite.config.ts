import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// Externalize node deps so the agent SDKs (ESM-only, and they spawn their own
// CLIs/servers) load from node_modules at runtime via dynamic import() instead
// of being bundled into the CommonJS main chunk.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [tailwindcss(), svelte()]
  }
})
