// The debugger end to end, against a fake adapter run as a real stdio process:
// breakpoints set before the session reach the adapter during its handshake, a
// stop focuses the right frame and is drawn into the editors, variables and
// evaluation read the paused frame, and stepping and continuing move the stop
// until the program ends. Also the editor's side: gutter clicks and marks that
// moved with an edit.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DebugOutputLine, DebugSnapshot } from '../src/shared/debug'
import { DebugAdapterRegistry } from '../src/main/debug/registry'
import { DebugService, focusFrameOf } from '../src/main/debug/service'

const WAIT_TIMEOUT_MS = 10_000

let directory: string
let programPath: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'grove-debug-'))
  programPath = join(directory, 'program.txt')
  writeFileSync(programPath, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
  const adapterModule = resolve(import.meta.dir, 'debugFakeAdapter.ts')
  const script = join(directory, 'fake-dap')
  writeFileSync(
    script,
    `#!/usr/bin/env bun\nimport { runFakeAdapter } from ${JSON.stringify(adapterModule)}\nrunFakeAdapter(process.stdin, process.stdout, 10)\n`
  )
  chmodSync(script, 0o755)
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A service wired to the fake adapter, recording what it sends to the UI and the editors. */
function createService(): {
  service: DebugService
  snapshots: DebugSnapshot[]
  output: DebugOutputLine[]
  nvimCalls: { id: string; args: unknown[] }[]
} {
  const snapshots: DebugSnapshot[] = []
  const output: DebugOutputLine[] = []
  const nvimCalls: { id: string; args: unknown[] }[] = []
  const registry = new DebugAdapterRegistry(() => [directory])
  registry.register({
    id: 'fake',
    label: 'Fake',
    types: ['fake'],
    languages: [],
    executable: 'fake-dap',
    launch: (executablePath) => ({ kind: 'stdio', command: executablePath, args: [] })
  })
  const service = new DebugService({
    registry,
    nvim: {
      sessionIds: () => ['nvim-1'],
      request: (id, _method, args) => {
        nvimCalls.push({ id, args })
        return Promise.resolve(null)
      }
    },
    send: (channel, payload) => {
      if (channel === 'event:debug-state') snapshots.push(payload as DebugSnapshot)
      if (channel === 'event:debug-output') output.push(payload as DebugOutputLine)
    },
    environmentFor: () => process.env,
    masonRoot: () => join(directory, 'mason'),
    headlessNvim: () => ({ binary: 'false', args: [], env: process.env }),
    load: () => Promise.resolve({ breakpoints: [], watches: [] }),
    save: () => Promise.resolve()
  })
  return { service, snapshots, output, nvimCalls }
}

/** Resolves once the service's snapshot satisfies the check. */
async function waitFor(
  service: DebugService,
  check: (snapshot: DebugSnapshot) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<DebugSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = service.snapshot()
    if (check(snapshot)) return snapshot
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error(`timed out; last snapshot: ${JSON.stringify(service.snapshot())}`)
}

/** Lets the batched snapshot publish run. */
function flush(): Promise<void> {
  return new Promise((resolveFlush) => setTimeout(resolveFlush, 0))
}

describe('a debug session', () => {
  test('stops on a breakpoint, reads the frame, steps and runs to the end', async () => {
    const { service, output, nvimCalls } = createService()
    await service.openRepo(directory)
    await service.setBreakpoint(programPath, 3)
    await service.setBreakpoint(programPath, 6)

    const sessionId = await service.start({
      worktreePath: directory,
      configuration: {
        type: 'fake',
        request: 'launch',
        name: 'Fake',
        program: '${workspaceFolder}/program.txt'
      }
    })

    let snapshot = await waitFor(service, (current) => current.stopSequence === 1)
    expect(snapshot.focusedSessionId).toBe(sessionId)
    expect(snapshot.focusedLocation).toEqual({ path: programPath, line: 3 })
    expect(snapshot.breakpoints.every((breakpoint) => breakpoint.verified)).toBe(true)
    const session = snapshot.sessions[0]
    expect(session.state).toBe('stopped')
    expect(session.stopReason).toBe('breakpoint')
    expect(session.exceptionFilters.map((filter) => [filter.filter, filter.enabled])).toEqual([
      ['raised', false],
      ['uncaught', true]
    ])
    expect(output.some((line) => line.text === `running ${programPath}\n`)).toBe(true)

    await flush()
    const lastDraw = nvimCalls[nvimCalls.length - 1].args[1] as [
      { stopped: unknown; sessionActive: boolean }
    ]
    expect(lastDraw[0].stopped).toEqual({ path: programPath, line: 3 })
    expect(lastDraw[0].sessionActive).toBe(true)

    const scopes = await service.scopes()
    expect(scopes.map((scope) => scope.name)).toEqual(['Locals'])
    const variables = await service.variables(sessionId, scopes[0].variablesReference)
    expect(variables.find((variable) => variable.name === 'line')?.value).toBe('3')
    const items = variables.find((variable) => variable.name === 'items')
    const children = await service.variables(sessionId, items?.variablesReference || 0)
    expect(children.map((child) => child.value)).toEqual(["'a'", "'b'"])

    const evaluation = await service.evaluate('answer', 'repl')
    expect(evaluation.result).toBe('answer@3')
    expect(output.slice(-2).map((line) => [line.category, line.text])).toEqual([
      ['input', 'answer\n'],
      ['result', 'answer@3\n']
    ])

    await service.stepOver()
    snapshot = await waitFor(service, (current) => current.stopSequence === 2)
    expect(snapshot.focusedLocation).toEqual({ path: programPath, line: 4 })

    await service.continue()
    snapshot = await waitFor(service, (current) => current.stopSequence === 3)
    expect(snapshot.focusedLocation).toEqual({ path: programPath, line: 6 })

    await service.continue()
    // The program's end lets the session go at once, not after a terminate's grace.
    snapshot = await waitFor(service, (current) => current.sessions.length === 0, 1000)
    expect(snapshot.focusedLocation).toBeNull()
    expect(snapshot.focusedSessionId).toBeNull()
    expect(output.some((line) => line.text === 'Process exited with code 0\n')).toBe(true)
  })

  test('refuses a configuration with variables Grove cannot fill in', async () => {
    const { service } = createService()
    await expect(
      service.start({
        worktreePath: directory,
        configuration: {
          type: 'fake',
          request: 'launch',
          name: 'Fake',
          program: '${input:pickProgram}'
        }
      })
    ).rejects.toThrow('${input:pickProgram}')
  })

  test('names a missing adapter instead of starting nothing', async () => {
    const { service } = createService()
    await expect(
      service.start({
        worktreePath: directory,
        configuration: { type: 'nope', request: 'launch', name: 'X' }
      })
    ).rejects.toThrow('No debug adapter for type "nope"')
  })
})

describe('breakpoints from the editor', () => {
  test('a gutter click toggles the line, and a new editor is sent the state', async () => {
    const { service, nvimCalls } = createService()
    await service.openRepo(directory)
    const handled = service.handleNvimNotify('nvim-1', 'grove_debug_toggle_breakpoint', [
      { path: programPath, line: 5 }
    ])
    expect(handled).toBe(true)
    await flush()
    expect(service.snapshot().breakpoints.map((breakpoint) => breakpoint.line)).toEqual([5])

    service.handleNvimNotify('nvim-2', 'grove_debug_ready', [{}])
    expect(nvimCalls[nvimCalls.length - 1].id).toBe('nvim-2')

    service.handleNvimNotify('nvim-1', 'grove_debug_toggle_breakpoint', [
      { path: programPath, line: 5 }
    ])
    await flush()
    expect(service.snapshot().breakpoints).toEqual([])
  })

  test('marks that moved with an edit move their breakpoints, merging ones that met', async () => {
    const { service } = createService()
    await service.openRepo(directory)
    const first = await service.setBreakpoint(programPath, 2)
    const second = await service.setBreakpoint(programPath, 4)
    service.handleNvimNotify('nvim-1', 'grove_debug_breakpoints_moved', [
      {
        path: programPath,
        moves: [
          { id: first.id, line: 7 },
          { id: second.id, line: 7 }
        ]
      }
    ])
    await flush()
    expect(service.snapshot().breakpoints.map((breakpoint) => breakpoint.line)).toEqual([7])
  })

  test('other notifications are left to the editor', () => {
    const { service } = createService()
    expect(service.handleNvimNotify('nvim-1', 'grove_diagnostics', [[]])).toBe(false)
  })
})

describe('focusFrameOf', () => {
  test('prefers the top frame with a file on disk', () => {
    expect(
      focusFrameOf([
        {
          id: 1,
          name: 'internal',
          line: 1,
          column: 1,
          presentationHint: 'subtle',
          path: '/lib.js'
        },
        { id: 2, name: 'native', line: 1, column: 1 },
        { id: 3, name: 'mine', line: 4, column: 1, path: '/app.js' }
      ])
    ).toBe(3)
    expect(focusFrameOf([{ id: 9, name: 'native', line: 1, column: 1 }])).toBe(9)
    expect(focusFrameOf([])).toBeNull()
  })
})
