// Development only: reloads a built-in plugin when its build output changes.
// `bun run dev` keeps `scripts/build-plugins.ts --watch` rebuilding
// resources/plugins/*/dist; this watches those dist folders and names the
// plugin that changed, so the renderer can restart its worker and reload its
// pages. A packaged app ships prebuilt plugins and never runs this.

import { watch, type FSWatcher } from 'fs'
import { basename, sep } from 'path'
import { builtinRoot, type PluginRegistry } from './loader'

// A build writes several files over a second or so (worker, then pages);
// wait for it to go quiet so the plugin reloads once, on the finished output.
const SETTLE_MS = 400

/**
 * Watches the built-in plugins' dist folders and calls `onRebuilt` with a
 * plugin's id once its output has settled. Returns the inverse.
 */
export function watchBuiltinBuilds(
  registry: PluginRegistry,
  onRebuilt: (pluginId: string) => void
): () => void {
  const timers = new Map<string, NodeJS.Timeout>()
  let watcher: FSWatcher
  try {
    watcher = watch(builtinRoot(), { recursive: true }, (_event, file) => {
      const pluginId = rebuiltPluginId(registry, file)
      if (!pluginId) return
      clearTimeout(timers.get(pluginId))
      timers.set(
        pluginId,
        setTimeout(() => {
          timers.delete(pluginId)
          onRebuilt(pluginId)
        }, SETTLE_MS)
      )
    })
  } catch (error) {
    console.warn(`plugin rebuild watcher: ${(error as Error).message}`)
    return () => {}
  }
  watcher.on('error', (error) => console.warn(`plugin rebuild watcher: ${error.message}`))
  return () => {
    watcher.close()
    for (const timer of timers.values()) clearTimeout(timer)
  }
}

/** The built-in plugin whose dist `file` (relative to the builtin root) is in, or null. */
function rebuiltPluginId(registry: PluginRegistry, file: string | null): string | null {
  if (!file) return null
  const [dir, folder] = file.split(sep)
  if (folder !== 'dist') return null
  const record = registry
    .list()
    .find((entry) => entry.source === 'builtin' && basename(entry.root) === dir)
  if (!record) return null
  return record.id
}
