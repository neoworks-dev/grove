// debugpy, Microsoft's Python adapter, as Mason installs it.
//
// The adapter runs from Mason's own virtualenv, so a configuration that names
// no interpreter would run the program there, without the project's packages.
// The project's interpreter is filled in the way nvim-dap-python finds it: an
// active VIRTUAL_ENV, then a `.venv` or `venv` in the worktree, then python3.

import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AdapterContext, DebugAdapterDescriptor } from '../registry'

const PYTHON_EXTENSIONS = new Set(['.py', '.pyw'])
const VIRTUALENV_DIRECTORIES = ['.venv', 'venv', 'env']

export const debugpy: DebugAdapterDescriptor = {
  id: 'debugpy',
  label: 'debugpy',
  types: ['debugpy', 'python'],
  languages: ['Python'],
  masonPackage: 'debugpy',
  executable: 'debugpy-adapter',
  launch: (executablePath) => ({ kind: 'stdio', command: executablePath, args: [] }),

  resolveConfiguration(configuration, context) {
    const resolved: Record<string, unknown> = { ...configuration, type: 'debugpy' }
    if (resolved.python === undefined && resolved.pythonPath === undefined) {
      resolved.python = projectInterpreter(context)
    }
    return resolved
  },

  currentFileConfiguration(filePath) {
    if (!PYTHON_EXTENSIONS.has(extname(filePath))) {
      return null
    }
    return {
      type: 'debugpy',
      request: 'launch',
      name: 'Python: current file',
      program: '${file}',
      cwd: '${workspaceFolder}',
      console: 'internalConsole',
      justMyCode: true
    }
  }
}

/** The interpreter the project runs with. */
export function projectInterpreter(context: AdapterContext): string {
  const active = context.env.VIRTUAL_ENV
  if (active && existsSync(join(active, 'bin', 'python'))) {
    return join(active, 'bin', 'python')
  }
  for (const directory of VIRTUALENV_DIRECTORIES) {
    const candidate = join(context.worktreePath, directory, 'bin', 'python')
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return 'python3'
}
