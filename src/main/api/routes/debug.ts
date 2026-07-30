// debug.* routes — a live inspection surface for developing against a running
// app. Registered ONLY when GROVE_DEBUG=1, because these routes run arbitrary
// Lua in the editor and arbitrary JavaScript in the renderer: with them the
// client owns the app. A normal build has no debug surface at all.
//
// The point is to make UI bugs diagnosable without a human describing what they
// see. A client can read nvim's real window/buffer/diff state and the renderer's
// own stores, which is the difference between knowing a diff failed to render
// and guessing why.

import { ApiError, type RouteRegistry } from '../registry'

export interface DebugRouteDeps {
  // Live nvim sessions, keyed as NeovimManager keys them ('nvim-1', …).
  nvimSessionIds: () => string[]
  nvimRequest: (id: string, method: string, args: unknown[]) => Promise<unknown>
  // Evaluate an expression in the renderer and resolve with its value. Values
  // must survive structured cloning — return plain data, not DOM nodes.
  rendererEval: (expression: string) => Promise<unknown>
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(`${key} is required`, 'invalid')
  }
  return value
}

/**
 * Register the debug routes. Callers must gate this on GROVE_DEBUG themselves —
 * it is deliberately not checked here, so the gate is visible at the call site
 * rather than buried in this module.
 */
export function registerDebugRoutes(registry: RouteRegistry, deps: DebugRouteDeps): void {
  registry.register({
    method: 'debug.nvim.sessions',
    scope: 'debug.all',
    handler: async () => ({ sessions: deps.nvimSessionIds() })
  })

  // Raw msgpack-rpc passthrough, for anything the convenience routes don't cover.
  registry.register({
    method: 'debug.nvim.request',
    scope: 'debug.all',
    describe: (params) => `call ${String(params.method)} on ${String(params.session)}`,
    handler: async (params) => {
      const session = resolveSession(deps, params)
      const method = requireString(params, 'method')
      const args = Array.isArray(params.args) ? params.args : []
      return { result: await deps.nvimRequest(session, method, args) }
    }
  })

  // Run Lua and get its return value back. `code` is a function body, so it must
  // `return` whatever it wants to read out.
  registry.register({
    method: 'debug.nvim.lua',
    scope: 'debug.all',
    describe: (params) => `run lua on ${String(params.session ?? 'the active session')}`,
    handler: async (params) => {
      const session = resolveSession(deps, params)
      const code = requireString(params, 'code')
      const args = Array.isArray(params.args) ? params.args : []
      return { result: await deps.nvimRequest(session, 'nvim_exec_lua', [code, args]) }
    }
  })

  // Window/buffer/diff state of every window in every tab page. The single most
  // useful call for "the diff did not render": it shows whether the review
  // windows exist, which buffers they hold, and whether diff mode survived.
  registry.register({
    method: 'debug.nvim.windows',
    scope: 'debug.all',
    handler: async (params) => {
      const session = resolveSession(deps, params)
      return { result: await deps.nvimRequest(session, 'nvim_exec_lua', [WINDOW_STATE_LUA, []]) }
    }
  })

  registry.register({
    method: 'debug.renderer.eval',
    scope: 'debug.all',
    describe: (params) => `evaluate in the renderer: ${String(params.expression).slice(0, 80)}`,
    handler: async (params) => {
      const expression = requireString(params, 'expression')
      // Serialise inside the renderer. Svelte's $state values are Proxies, which
      // structured cloning across the IPC boundary rejects outright ("An object
      // could not be cloned") — JSON does not care. Promises are awaited first so
      // an async expression can be evaluated too.
      const wrapped = `Promise.resolve((() => (${expression}))()).then(
        (value) => JSON.stringify(value === undefined ? null : value)
      )`
      const json = (await deps.rendererEval(wrapped)) as string | null
      return { result: json === null || json === undefined ? null : JSON.parse(json) }
    }
  })
}

// The session to act on: the one named, or the only one open. Ambiguity is an
// error rather than a guess — acting on the wrong editor would be invisible.
function resolveSession(deps: DebugRouteDeps, params: Record<string, unknown>): string {
  const requested = params.session
  const sessions = deps.nvimSessionIds()
  if (typeof requested === 'string' && requested.length > 0) {
    if (!sessions.includes(requested)) {
      throw new ApiError(`unknown nvim session: ${requested}`, 'invalid')
    }
    return requested
  }
  if (sessions.length === 0) throw new ApiError('no nvim session is running', 'internal')
  if (sessions.length > 1) {
    throw new ApiError(
      `several nvim sessions are open (${sessions.join(', ')}) — name one with "session"`,
      'invalid'
    )
  }
  return sessions[0]
}

// Every tab page, its windows, and for each window the buffer it holds, that
// buffer's name, and whether the window is in diff mode. Also reports grove's
// own review bookkeeping so a stale handle is obvious.
const WINDOW_STATE_LUA = `
local tabs = {}
for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
  local windows = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    local buf = vim.api.nvim_win_get_buf(win)
    table.insert(windows, {
      win = win,
      buf = buf,
      name = vim.api.nvim_buf_get_name(buf),
      buftype = vim.bo[buf].buftype,
      modifiable = vim.bo[buf].modifiable,
      filetype = vim.bo[buf].filetype,
      lines = vim.api.nvim_buf_line_count(buf),
      diff = vim.wo[win].diff,
      width = vim.api.nvim_win_get_width(win),
      current = win == vim.api.nvim_get_current_win()
    })
  end
  table.insert(tabs, {
    tab = tab,
    number = vim.api.nvim_tabpage_get_number(tab),
    current = tab == vim.api.nvim_get_current_tabpage(),
    windows = windows
  })
end
return {
  tabs = tabs,
  review = {
    tab = vim.g.grove_review_tab,
    win = vim.g.grove_review_win,
    wins = vim.g.grove_review_wins
  }
}
`
