// Adapters for compiled code: CodeLLDB and Delve from Mason, and the DAP
// servers built into GDB (14+) and LLVM (lldb-dap), found on PATH when the
// system has them. None offers a current-file configuration — a source file is
// not what runs; the project's launch.json names the binary.

import { extname, dirname } from 'node:path'
import type { DebugAdapterDescriptor } from '../registry'

export const codelldb: DebugAdapterDescriptor = {
  id: 'codelldb',
  label: 'CodeLLDB',
  types: ['lldb', 'codelldb'],
  languages: ['C', 'C++', 'Rust', 'Zig'],
  masonPackage: 'codelldb',
  executable: 'codelldb',
  launch: (executablePath, port) => ({
    kind: 'server',
    command: executablePath,
    args: ['--port', String(port)],
    host: '127.0.0.1',
    port
  })
}

export const delve: DebugAdapterDescriptor = {
  id: 'delve',
  label: 'Delve',
  types: ['go', 'delve'],
  languages: ['Go'],
  masonPackage: 'delve',
  executable: 'dlv',
  launch: (executablePath, port) => ({
    kind: 'server',
    command: executablePath,
    args: ['dap', '-l', `127.0.0.1:${port}`],
    host: '127.0.0.1',
    port
  }),

  currentFileConfiguration(filePath) {
    if (extname(filePath) !== '.go') {
      return null
    }
    return {
      type: 'go',
      request: 'launch',
      name: 'Go: current package',
      mode: 'debug',
      program: dirname(filePath)
    }
  }
}

export const gdb: DebugAdapterDescriptor = {
  id: 'gdb',
  label: 'GDB',
  types: ['gdb'],
  languages: ['C', 'C++', 'Rust', 'Ada', 'Fortran'],
  executable: 'gdb',
  launch: (executablePath) => ({ kind: 'stdio', command: executablePath, args: ['-i', 'dap'] })
}

export const lldbDap: DebugAdapterDescriptor = {
  id: 'lldb-dap',
  label: 'lldb-dap',
  types: ['lldb-dap'],
  languages: ['C', 'C++', 'Rust', 'Swift'],
  executable: 'lldb-dap',
  launch: (executablePath) => ({ kind: 'stdio', command: executablePath, args: [] })
}
