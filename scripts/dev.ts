// `bun run dev`: electron-vite's dev server, with the built-in plugins
// rebuilt as they change. Electron starts once the watcher's first build is
// done, since Grove loads the plugins on boot; after that the watcher keeps
// their dist/ current and Grove reloads whichever one changed. Stopping
// either process stops both.
// Run with: bun scripts/dev.ts

import { spawn, type ChildProcess } from 'child_process'

// What build-plugins.ts prints once its first build is done and it is watching.
const WATCHING_LINE = 'watching plugins for changes'

/** Starts the plugin watcher, resolving once its first build has finished. */
function startPluginWatcher(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['scripts/build-plugins.ts', '--watch'], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let started = false
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      if (started || !chunk.toString().includes(WATCHING_LINE)) return
      started = true
      resolve(child)
    })
    child.on('exit', (code) => {
      if (!started) reject(new Error(`plugin build exited with ${code}`))
    })
  })
}

const pluginWatcher = await startPluginWatcher()
const electron = spawn('electron-vite', ['dev', ...process.argv.slice(2)], { stdio: 'inherit' })

/** Stops both processes and leaves with `code`. */
function stopAll(code: number | null): void {
  pluginWatcher.kill()
  electron.kill()
  process.exit(code ?? 0)
}

electron.on('exit', stopAll)
pluginWatcher.on('exit', stopAll)
process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
