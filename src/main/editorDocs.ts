// Editor document bridge: exposes nvim buffers as path-keyed documents with
// changedtick-backed versions. Every check-and-mutate runs as ONE
// nvim_exec_lua call inside nvim's single-threaded event loop, so the version
// check and the edit are atomic (no TOCTOU against user typing). Buffer
// numbers never leave the lua calls — clients only ever see worktree-relative
// paths and version numbers. Columns are byte offsets (1-based over the
// wire), matching nvim's API semantics.

import { isAbsolute, join, relative, sep } from 'path'

export interface EditorNvimBridge {
  request(sessionId: string, method: string, args: unknown[]): Promise<unknown>
}

export interface EditorSessionInfo {
  sessionId: string
  worktreeId: string
}

export interface EditorDocsDeps {
  nvim: EditorNvimBridge
  // Canonical session for a worktree (most recently active one holding it).
  sessionFor: (worktreeId: string) => string | null
  allSessions: () => EditorSessionInfo[]
  activeSession: () => EditorSessionInfo | null
  worktreePathOf: (worktreeId: string) => string
  publish: (topic: string, payload: unknown, worktreeId?: string) => void
}

export interface DocumentInfo {
  worktreeId: string
  path: string
  version: number
  lineCount: number
  languageId: string
  dirty: boolean
}

export interface EditorViewInfo {
  document: DocumentInfo
  active: boolean
  selections: { start: Position; end: Position }[]
}

export interface Position {
  line: number
  column: number
}

export interface RangedEdit {
  range: { start: Position; end: Position }
  newText: string
}

export type EditOutcome =
  | { status: 'applied'; version: number }
  | { status: 'stale'; currentVersion: number }

// Semantic style names → nvim highlight groups. Clients never pass raw
// groups or colors.
const STYLE_GROUPS: Record<string, string> = {
  info: 'DiagnosticUnderlineInfo',
  warning: 'DiagnosticUnderlineWarn',
  error: 'DiagnosticUnderlineError',
  hint: 'DiagnosticUnderlineHint',
  added: 'DiffAdd',
  removed: 'DiffDelete',
  highlight: 'Search'
}

// ── Pure edit preparation (unit-tested) ─────────────────────────

export interface PreparedEdit {
  startRow: number // 0-based
  startCol: number // 0-based byte offset
  endRow: number
  endCol: number
  lines: string[]
}

// Validate, convert to 0-based, and order descending by start so earlier
// ranges stay valid while later ones are replaced. Overlapping edits are
// rejected — apply order would make the result ambiguous.
export function prepareEdits(edits: RangedEdit[]): PreparedEdit[] {
  const prepared = edits.map(toPrepared)
  prepared.sort((a, b) => {
    if (a.startRow !== b.startRow) return b.startRow - a.startRow
    return b.startCol - a.startCol
  })
  for (let i = 1; i < prepared.length; i++) {
    const later = prepared[i - 1]
    const earlier = prepared[i]
    if (comparePositions(earlier.endRow, earlier.endCol, later.startRow, later.startCol) > 0) {
      throw new Error('overlapping edits are not allowed')
    }
  }
  return prepared
}

function toPrepared(edit: RangedEdit): PreparedEdit {
  const { start, end } = edit.range
  if (start.line < 1 || start.column < 1 || end.line < 1 || end.column < 1) {
    throw new Error('positions are 1-based')
  }
  if (comparePositions(start.line, start.column, end.line, end.column) > 0) {
    throw new Error('range end precedes range start')
  }
  return {
    startRow: start.line - 1,
    startCol: start.column - 1,
    endRow: end.line - 1,
    endCol: end.column - 1,
    lines: edit.newText.split('\n')
  }
}

function comparePositions(rowA: number, colA: number, rowB: number, colB: number): number {
  if (rowA !== rowB) return rowA - rowB
  return colA - colB
}

// Reference implementation of the lua apply, used by tests to pin semantics.
export function applyPreparedToLines(lines: string[], prepared: PreparedEdit[]): string[] {
  const result = [...lines]
  for (const edit of prepared) {
    const startLine = result[edit.startRow] ?? ''
    const endLine = result[edit.endRow] ?? ''
    const head = startLine.slice(0, edit.startCol)
    const tail = endLine.slice(edit.endCol)
    const replacement = [...edit.lines]
    replacement[0] = head + replacement[0]
    replacement[replacement.length - 1] = replacement[replacement.length - 1] + tail
    result.splice(edit.startRow, edit.endRow - edit.startRow + 1, ...replacement)
  }
  return result
}

// ── Lua snippets ────────────────────────────────────────────────
// Each runs atomically inside nvim. `...` unpacks the args array.

const LUA_OPEN = `
local path = ...
local buf = vim.fn.bufadd(path)
vim.fn.bufload(buf)
if not vim.b[buf].grove_doc_watch then
  vim.b[buf].grove_doc_watch = true
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
    buffer = buf,
    callback = function()
      vim.rpcnotify(0, 'grove_doc_changed',
        vim.api.nvim_buf_get_name(buf),
        vim.api.nvim_buf_get_changedtick(buf))
    end
  })
end
return {
  tick = vim.api.nvim_buf_get_changedtick(buf),
  lineCount = vim.api.nvim_buf_line_count(buf),
  languageId = vim.bo[buf].filetype,
  dirty = vim.bo[buf].modified
}
`

const LUA_READ = `
local path = ...
local buf = vim.fn.bufnr(path)
if buf == -1 then return nil end
return {
  tick = vim.api.nvim_buf_get_changedtick(buf),
  lineCount = vim.api.nvim_buf_line_count(buf),
  languageId = vim.bo[buf].filetype,
  dirty = vim.bo[buf].modified,
  lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
}
`

const LUA_APPLY_EDITS = `
local path, expected, edits = ...
local buf = vim.fn.bufnr(path)
if buf == -1 then return { missing = true } end
local tick = vim.api.nvim_buf_get_changedtick(buf)
if tick ~= expected then return { stale = true, currentVersion = tick } end
for _, e in ipairs(edits) do
  vim.api.nvim_buf_set_text(buf, e.startRow, e.startCol, e.endRow, e.endCol, e.lines)
end
return { version = vim.api.nvim_buf_get_changedtick(buf) }
`

const LUA_SAVE = `
local path, expected = ...
local buf = vim.fn.bufnr(path)
if buf == -1 then return { missing = true } end
local tick = vim.api.nvim_buf_get_changedtick(buf)
if expected ~= vim.NIL and tick ~= expected then
  return { stale = true, currentVersion = tick }
end
vim.api.nvim_buf_call(buf, function() vim.cmd('silent keepalt write') end)
return { version = vim.api.nvim_buf_get_changedtick(buf) }
`

const LUA_GET_SELECTIONS = `
local path = ...
local buf = vim.fn.bufnr(path)
if buf == -1 then return nil end
local wins = vim.fn.win_findbuf(buf)
if #wins == 0 then return {} end
local cursor = vim.api.nvim_win_get_cursor(wins[1])
return { { line = cursor[1], column = cursor[2] + 1 } }
`

const LUA_SET_CURSOR = `
local path, expected, line, column = ...
local buf = vim.fn.bufnr(path)
if buf == -1 then return { missing = true } end
local tick = vim.api.nvim_buf_get_changedtick(buf)
if expected ~= vim.NIL and tick ~= expected then
  return { stale = true, currentVersion = tick }
end
local wins = vim.fn.win_findbuf(buf)
if #wins == 0 then return { missing = true } end
vim.api.nvim_win_set_cursor(wins[1], { line, column - 1 })
return { version = tick }
`

const LUA_SET_DECORATIONS = `
local path, nsName, marks = ...
local buf = vim.fn.bufnr(path)
if buf == -1 then return { missing = true } end
local ns = vim.api.nvim_create_namespace(nsName)
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
for _, m in ipairs(marks) do
  pcall(vim.api.nvim_buf_set_extmark, buf, ns, m.startRow, m.startCol, {
    end_row = m.endRow,
    end_col = m.endCol,
    hl_group = m.group,
    strict = false
  })
end
return { ok = true }
`

const LUA_CURRENT_VIEW = `
local buf = vim.api.nvim_get_current_buf()
local cursor = vim.api.nvim_win_get_cursor(0)
return {
  name = vim.api.nvim_buf_get_name(buf),
  tick = vim.api.nvim_buf_get_changedtick(buf),
  lineCount = vim.api.nvim_buf_line_count(buf),
  languageId = vim.bo[buf].filetype,
  dirty = vim.bo[buf].modified,
  line = cursor[1],
  column = cursor[2] + 1
}
`

// ── The registry ────────────────────────────────────────────────

interface LuaDocShape {
  tick: number
  lineCount: number
  languageId: string
  dirty: boolean
  lines?: string[]
}

interface LuaMutationShape {
  missing?: boolean
  stale?: boolean
  currentVersion?: number
  version?: number
}

export class DocumentRegistry {
  private deps: EditorDocsDeps

  constructor(deps: EditorDocsDeps) {
    this.deps = deps
  }

  private session(worktreeId: string): string {
    const sessionId = this.deps.sessionFor(worktreeId)
    if (!sessionId) throw new Error('no editor session for this worktree')
    return sessionId
  }

  private absPath(worktreeId: string, path: string): string {
    if (isAbsolute(path)) return path
    return join(this.deps.worktreePathOf(worktreeId), path)
  }

  private async lua(
    sessionId: string,
    code: string,
    args: unknown[]
  ): Promise<unknown> {
    return this.deps.nvim.request(sessionId, 'nvim_exec_lua', [code, args])
  }

  async open(worktreeId: string, path: string): Promise<DocumentInfo> {
    const sessionId = this.session(worktreeId)
    const raw = (await this.lua(sessionId, LUA_OPEN, [
      this.absPath(worktreeId, path)
    ])) as LuaDocShape | null
    if (!raw) throw new Error(`could not open document: ${path}`)
    return this.docInfo(worktreeId, path, raw)
  }

  async read(
    worktreeId: string,
    path: string
  ): Promise<{ document: DocumentInfo; lines: string[] }> {
    const sessionId = this.session(worktreeId)
    let raw = (await this.lua(sessionId, LUA_READ, [
      this.absPath(worktreeId, path)
    ])) as LuaDocShape | null
    if (!raw) {
      await this.open(worktreeId, path)
      raw = (await this.lua(sessionId, LUA_READ, [
        this.absPath(worktreeId, path)
      ])) as LuaDocShape | null
    }
    if (!raw) throw new Error(`could not read document: ${path}`)
    return {
      document: this.docInfo(worktreeId, path, raw),
      lines: raw.lines ?? []
    }
  }

  async applyEdit(
    worktreeId: string,
    path: string,
    expectedVersion: number,
    edits: RangedEdit[]
  ): Promise<EditOutcome> {
    const prepared = prepareEdits(edits)
    const sessionId = this.session(worktreeId)
    const raw = (await this.lua(sessionId, LUA_APPLY_EDITS, [
      this.absPath(worktreeId, path),
      expectedVersion,
      prepared.map((edit) => ({
        startRow: edit.startRow,
        startCol: edit.startCol,
        endRow: edit.endRow,
        endCol: edit.endCol,
        lines: edit.lines
      }))
    ])) as LuaMutationShape | null
    return this.mutationOutcome(raw, path)
  }

  async save(
    worktreeId: string,
    path: string,
    expectedVersion: number | undefined
  ): Promise<EditOutcome> {
    const sessionId = this.session(worktreeId)
    const raw = (await this.lua(sessionId, LUA_SAVE, [
      this.absPath(worktreeId, path),
      expectedVersion ?? null
    ])) as LuaMutationShape | null
    return this.mutationOutcome(raw, path)
  }

  async getSelections(
    worktreeId: string,
    path: string
  ): Promise<{ start: Position; end: Position }[]> {
    const sessionId = this.session(worktreeId)
    const raw = (await this.lua(sessionId, LUA_GET_SELECTIONS, [
      this.absPath(worktreeId, path)
    ])) as Position[] | null
    if (!raw) return []
    return raw.map((position) => ({ start: position, end: position }))
  }

  async setSelections(
    worktreeId: string,
    path: string,
    selections: { start: Position; end: Position }[],
    expectedVersion: number | undefined
  ): Promise<EditOutcome> {
    if (selections.length === 0) throw new Error('at least one selection is required')
    const target = selections[0].start
    const sessionId = this.session(worktreeId)
    const raw = (await this.lua(sessionId, LUA_SET_CURSOR, [
      this.absPath(worktreeId, path),
      expectedVersion ?? null,
      target.line,
      target.column
    ])) as LuaMutationShape | null
    return this.mutationOutcome(raw, path)
  }

  async setDecorations(
    worktreeId: string,
    path: string,
    ownerKey: string,
    decorations: { range: { start: Position; end: Position }; style: string }[]
  ): Promise<void> {
    const sessionId = this.session(worktreeId)
    const marks = decorations.map((decoration) => ({
      startRow: decoration.range.start.line - 1,
      startCol: decoration.range.start.column - 1,
      endRow: decoration.range.end.line - 1,
      endCol: decoration.range.end.column - 1,
      group: STYLE_GROUPS[decoration.style] ?? STYLE_GROUPS.highlight
    }))
    const raw = (await this.lua(sessionId, LUA_SET_DECORATIONS, [
      this.absPath(worktreeId, path),
      `grove-api:${ownerKey}`,
      marks
    ])) as LuaMutationShape | null
    if (!raw || raw.missing) throw new Error(`document not open: ${path}`)
  }

  async listEditors(): Promise<EditorViewInfo[]> {
    const active = this.deps.activeSession()
    const editors: EditorViewInfo[] = []
    for (const session of this.deps.allSessions()) {
      const view = await this.currentView(session)
      if (!view) continue
      editors.push({ ...view, active: session.sessionId === active?.sessionId })
    }
    return editors
  }

  async getActiveEditor(): Promise<EditorViewInfo | null> {
    const active = this.deps.activeSession()
    if (!active) return null
    const view = await this.currentView(active)
    if (!view) return null
    return { ...view, active: true }
  }

  // grove_doc_changed notifications (autocmd installed on open) fan out as
  // editor.didChangeDocument events.
  handleNotify(sessionWorktreeId: string | null, method: string, args: unknown[]): void {
    if (method !== 'grove_doc_changed' || !sessionWorktreeId) return
    const [absPath, version] = args as [string, number]
    const worktreePath = this.safeWorktreePath(sessionWorktreeId)
    if (!worktreePath) return
    this.deps.publish(
      'editor.didChangeDocument',
      {
        worktreeId: sessionWorktreeId,
        path: this.relativePath(worktreePath, absPath),
        version
      },
      sessionWorktreeId
    )
  }

  private async currentView(
    session: EditorSessionInfo
  ): Promise<Omit<EditorViewInfo, 'active'> | null> {
    const raw = (await this.lua(session.sessionId, LUA_CURRENT_VIEW, [])) as
      | (LuaDocShape & { name: string; line: number; column: number; tick: number })
      | null
    if (!raw || !raw.name) return null
    const worktreePath = this.safeWorktreePath(session.worktreeId)
    if (!worktreePath) return null
    const cursor: Position = { line: raw.line, column: raw.column }
    return {
      document: this.docInfo(session.worktreeId, this.relativePath(worktreePath, raw.name), raw),
      selections: [{ start: cursor, end: cursor }]
    }
  }

  private docInfo(worktreeId: string, path: string, raw: LuaDocShape): DocumentInfo {
    return {
      worktreeId,
      path,
      version: raw.tick,
      lineCount: raw.lineCount,
      languageId: raw.languageId || 'plaintext',
      dirty: raw.dirty === true
    }
  }

  private mutationOutcome(raw: LuaMutationShape | null, path: string): EditOutcome {
    if (!raw || raw.missing) throw new Error(`document not open: ${path}`)
    if (raw.stale) return { status: 'stale', currentVersion: raw.currentVersion ?? 0 }
    return { status: 'applied', version: raw.version ?? 0 }
  }

  private safeWorktreePath(worktreeId: string): string | null {
    try {
      return this.deps.worktreePathOf(worktreeId)
    } catch {
      return null
    }
  }

  private relativePath(worktreePath: string, absPath: string): string {
    const rel = relative(worktreePath, absPath)
    if (rel.startsWith('..' + sep) || rel === '..') return absPath
    return rel
  }
}
