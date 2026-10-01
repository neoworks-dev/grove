// Launch configurations come from the project's launch.json and from adapters
// for the open file; nothing else. launch.json is JSONC with per-platform
// blocks, and VS Code's variables are filled in when a configuration starts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchConfigurationsOf,
  listConfigurations,
  substituteVariables,
  withPlatformOverrides
} from '../src/main/debug/configurations'
import { DebugAdapterRegistry } from '../src/main/debug/registry'
import { debugpy } from '../src/main/debug/adapters/python'
import { jsDebug } from '../src/main/debug/adapters/javascript'

let directory: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'grove-launch-'))
  mkdirSync(join(directory, '.vscode'))
  writeFileSync(
    join(directory, '.vscode', 'launch.json'),
    `{
      // The project's own configurations.
      "version": "0.2.0",
      "configurations": [
        { "name": "Server", "type": "node", "request": "launch", "program": "\${workspaceFolder}/server.js", },
        { "name": "Attach", "type": "debugpy", "request": "attach", "connect": { "port": 5678 } },
        { "type": "missing-name" },
      ],
    }`
  )
  mkdirSync(join(directory, 'bin'))
  writeFileSync(join(directory, 'bin', 'debugpy-adapter'), '#!/bin/sh\n')
  chmodSync(join(directory, 'bin', 'debugpy-adapter'), 0o755)
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('launch.json', () => {
  test('reads comments and trailing commas, and skips entries without a name or type', () => {
    const configurations = launchConfigurationsOf(
      `{ "configurations": [ { "name": "A", "type": "x", }, /* gone */ { "name": "B" } ] }`
    )
    expect(configurations).toEqual([{ name: 'A', type: 'x' }])
  })

  test('merges the block for this platform over the rest', () => {
    const merged = withPlatformOverrides(
      { name: 'A', type: 'x', program: 'a', linux: { program: 'b' }, windows: { program: 'c' } },
      'linux'
    )
    expect(merged).toEqual({ name: 'A', type: 'x', program: 'b' })
  })
})

describe('listConfigurations', () => {
  test("lists launch.json's, then the adapters' for the open file, with adapter readiness", async () => {
    const registry = new DebugAdapterRegistry(() => [join(directory, 'bin')])
    registry.register(debugpy)
    registry.register(jsDebug)
    const entries = await listConfigurations(registry, {
      worktreePath: directory,
      activeFile: join(directory, 'tool.py')
    })
    expect(
      entries.map((entry) => [
        entry.name,
        entry.source,
        entry.request,
        entry.adapterReady,
        entry.installPackage
      ])
    ).toEqual([
      ['Server', 'launch.json', 'launch', false, 'js-debug-adapter'],
      ['Attach', 'launch.json', 'attach', true, null],
      ['Python: current file', 'adapter', 'launch', true, null]
    ])
  })

  test('offers nothing for the open file when no adapter knows it', async () => {
    const registry = new DebugAdapterRegistry(() => [])
    registry.register(debugpy)
    const entries = await listConfigurations(registry, {
      worktreePath: join(directory, 'nowhere'),
      activeFile: '/x/readme.md'
    })
    expect(entries).toEqual([])
  })
})

describe('substituteVariables', () => {
  test("fills in the worktree, the file and the environment, and reports what it can't", () => {
    const { configuration, unresolved } = substituteVariables(
      {
        program: '${file}',
        cwd: '${workspaceFolder}',
        args: [
          '${fileBasenameNoExtension}',
          '${relativeFile}:${lineNumber}',
          '${env:GROVE_TEST_VALUE}'
        ],
        nested: { pick: '${command:pickProcess}' }
      },
      {
        worktreePath: '/repo',
        activeFile: '/repo/src/tool.py',
        activeLine: 12,
        env: { GROVE_TEST_VALUE: 'set' }
      }
    )
    expect(configuration).toEqual({
      program: '/repo/src/tool.py',
      cwd: '/repo',
      args: ['tool', 'src/tool.py:12', 'set'],
      nested: { pick: '${command:pickProcess}' }
    })
    expect(unresolved).toEqual(['${command:pickProcess}'])
  })
})
