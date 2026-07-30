// Shared helpers for the debug harness: typed wrappers over the debug.* routes,
// plus the polling primitive scenarios use to wait on app state.

import type { GroveClient } from '../../sdk/src/client/node'

export function print(label: string, value: unknown): void {
  console.log(`\n── ${label} ──`)
  console.log(JSON.stringify(value, null, 2))
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Run Lua in the editor. The code is a function body, so it must `return`. */
export async function lua(
  grove: GroveClient,
  code: string,
  args: unknown[] = []
): Promise<unknown> {
  const response = (await grove.raw.request('debug.nvim.lua', { code, args })) as {
    result: unknown
  }
  return response.result
}

/**
 * Evaluate an expression in the renderer. An expression returning a promise is
 * awaited on the renderer side, so `await`-shaped work can be driven from here.
 */
export async function evaluate(grove: GroveClient, expression: string): Promise<unknown> {
  const response = (await grove.raw.request('debug.renderer.eval', { expression })) as {
    result: unknown
  }
  return response.result
}

export interface NvimWindow {
  win: number
  buf: number
  name: string
  buftype: string
  modifiable: boolean
  diff: boolean
  width: number
  current: boolean
  lines: number
}

export interface NvimTab {
  tab: number
  number: number
  current: boolean
  windows: NvimWindow[]
}

export interface WindowState {
  tabs?: NvimTab[]
  review?: { tab?: unknown; win?: unknown; wins?: unknown }
}

export async function windows(grove: GroveClient): Promise<WindowState> {
  const response = (await grove.raw.request('debug.nvim.windows')) as { result: WindowState }
  return response.result
}

/** Windows currently in diff mode, across every tab page. */
export function diffWindows(state: WindowState): NvimWindow[] {
  return state.tabs?.flatMap((tab) => tab.windows.filter((entry) => entry.diff)) ?? []
}

/**
 * Poll a renderer expression until it yields something truthy, or give up.
 * Returns null on timeout rather than throwing, so a scenario can report the
 * timeout as a finding instead of dying on it.
 */
export async function pollUntil<T>(
  grove: GroveClient,
  expression: string,
  timeoutMs = 30_000,
  intervalMs = 400
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = (await evaluate(grove, expression)) as T
    if (value !== null && value !== undefined && value !== false) return value
    await wait(intervalMs)
  }
  return null
}
