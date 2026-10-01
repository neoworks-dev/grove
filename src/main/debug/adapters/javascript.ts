// vscode-js-debug, the adapter behind VS Code's Node and browser debugging.
//
// It runs as a server and debugs every process it attaches to in a child
// session of its own, which it asks the client to open with `startDebugging`;
// the service connects a second socket for each. launch.json's older `node`
// and `chrome` types are the same adapter under js-debug's `pwa-` names.

import { extname } from 'node:path'
import type { DebugAdapterDescriptor } from '../registry'

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])

/** launch.json types js-debug only knows under its own name. */
const RENAMED_TYPES: Record<string, string> = {
  node: 'pwa-node',
  chrome: 'pwa-chrome',
  msedge: 'pwa-msedge'
}

export const jsDebug: DebugAdapterDescriptor = {
  id: 'js-debug',
  label: 'JavaScript Debugger',
  types: ['pwa-node', 'node', 'node-terminal', 'pwa-chrome', 'chrome', 'pwa-msedge', 'msedge'],
  languages: ['JavaScript', 'TypeScript'],
  masonPackage: 'js-debug-adapter',
  executable: 'js-debug-adapter',
  launch: (executablePath, port) => ({
    kind: 'server',
    command: executablePath,
    args: [String(port), '127.0.0.1'],
    host: '127.0.0.1',
    port
  }),

  resolveConfiguration(configuration) {
    const type = String(configuration.type)
    const renamed = RENAMED_TYPES[type]
    if (!renamed) {
      return configuration
    }
    return { ...configuration, type: renamed }
  },

  currentFileConfiguration(filePath) {
    if (!SCRIPT_EXTENSIONS.has(extname(filePath))) {
      return null
    }
    return {
      type: 'pwa-node',
      request: 'launch',
      name: 'Node: current file',
      program: '${file}',
      cwd: '${workspaceFolder}',
      skipFiles: ['<node_internals>/**']
    }
  }
}
