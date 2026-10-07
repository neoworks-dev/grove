// Minimap math for the embedded Neovim pane. nvim gives us buffer text plus a
// window view (topline/botline over a total line count) rather than pixel
// scroll geometry, so the geometry here is line-based. Kept DOM-free and pure
// for unit testing.

// A horizontal stretch of one line drawn in a single color. Columns are
// character offsets from the line start, capped at MAX_COLS.
export interface LineRun {
  fromCol: number
  toCol: number
  color: string
}

export const LINE_PITCH = 3
export const GLYPH_HEIGHT = 1
export const COL_WIDTH = 0.6
export const MAX_COLS = 120

export interface MinimapGeometry {
  // Height of the whole map in CSS px (total lines * LINE_PITCH).
  contentHeight: number
  // How far the content is slid up when taller than the canvas.
  mapScrollTop: number
  indicatorTop: number
  indicatorHeight: number
}

// A highlighted span within one line, as returned by the nvim treesitter pass:
// [startCol, endCol, cssColor].
export type ColorSpan = [number, number, string]

/**
 * What each row of the window shows, top to bottom, where that is not simply
 * one buffer line per row: in diff mode, unchanged stretches fold away and
 * filler rows stand in for lines only the other side has. A positive entry is
 * the buffer line on that row, a negative one a closed fold starting at that
 * line, and 0 a filler row.
 */
export type DisplayRows = number[]

// How wide a closed fold's placeholder run is drawn, in columns.
const FOLD_COLS = 24

/**
 * Per-line runs rearranged into per-row runs: a buffer line keeps its own, a
 * closed fold becomes one flat run (when a colour is given), a filler row stays
 * empty.
 */
export function runsForRows(
  runs: LineRun[][],
  rows: DisplayRows,
  foldColor: string | null
): LineRun[][] {
  return rows.map((entry) => {
    if (entry > 0) return runs[entry - 1] ?? []
    if (entry < 0 && foldColor !== null) {
      return [{ fromCol: 0, toCol: FOLD_COLS, color: foldColor }]
    }
    return []
  })
}

/** The 1-based row a buffer line sits on, or the row of the fold hiding it. */
export function rowForLine(rows: DisplayRows, line: number): number {
  let row = 0
  for (let index = 0; index < rows.length; index++) {
    const entry = rows[index]
    if (entry === 0) continue
    if (Math.abs(entry) > line) break
    row = index + 1
  }
  return Math.max(1, row)
}

/**
 * The buffer line to put at the top of the window for a 1-based row: the row's
 * own line, a fold's first line, or for a filler row the line below it.
 */
export function lineForRow(rows: DisplayRows, row: number): number {
  for (let index = Math.max(0, row - 1); index < rows.length; index++) {
    if (rows[index] !== 0) return Math.abs(rows[index])
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index] !== 0) return Math.abs(rows[index])
  }
  return 1
}

// Colored runs from per-line treesitter spans (empty where a language/parser is
// unavailable — the monochrome base still draws the text shape underneath).
export function buildColoredRuns(spans: ColorSpan[][]): LineRun[][] {
  return spans.map((line) => {
    const runs: LineRun[] = []
    if (!Array.isArray(line)) return runs
    for (const [start, end, color] of line) {
      if (start >= MAX_COLS) continue
      const toCol = Math.min(end, MAX_COLS)
      if (toCol > start) runs.push({ fromCol: start, toCol, color })
    }
    return runs
  })
}

// One monochrome run per non-whitespace chunk so the map keeps the text shape
// (indentation and gaps stay visible), capped at MAX_COLS.
export function buildLineRuns(lines: string[], color: string): LineRun[][] {
  return lines.map((text) => {
    const runs: LineRun[] = []
    const capped = text.slice(0, MAX_COLS)
    const chunkPattern = /\S+/g
    let match = chunkPattern.exec(capped)
    while (match !== null) {
      runs.push({ fromCol: match.index, toCol: match.index + match[0].length, color })
      match = chunkPattern.exec(capped)
    }
    return runs
  })
}

export function computeGeometry(
  total: number,
  topline: number,
  botline: number,
  canvasHeight: number
): MinimapGeometry {
  const lines = Math.max(1, total)
  const contentHeight = lines * LINE_PITCH
  const visibleLines = Math.max(1, botline - topline + 1)
  const maxTop = Math.max(0, lines - visibleLines)
  const scrollRatio = maxTop > 0 ? (topline - 1) / maxTop : 0
  const mapScrollTop = Math.max(0, contentHeight - canvasHeight) * scrollRatio
  const indicatorHeight = Math.min(canvasHeight, visibleLines * LINE_PITCH)
  const indicatorTop = (topline - 1) * LINE_PITCH - mapScrollTop
  return { contentHeight, mapScrollTop, indicatorTop, indicatorHeight }
}

// Invert a canvas y coordinate to the buffer line that should sit at the top of
// the viewport, clamped to [1, total].
export function toplineForY(y: number, mapScrollTop: number, total: number): number {
  const line = Math.round((y + mapScrollTop) / LINE_PITCH) + 1
  return Math.max(1, Math.min(line, Math.max(1, total)))
}

// Keep the cursor line inside the new viewport after a scroll so nvim doesn't
// yank the view back to follow an off-screen cursor.
export function clampCursorLine(
  lnum: number,
  topline: number,
  visibleLines: number,
  total: number
): number {
  const bottom = Math.min(total, topline + Math.max(1, visibleLines) - 1)
  return Math.max(topline, Math.min(lnum, bottom))
}

/**
 * The visual selection as nvim reports it: the kind, and the anchor and cursor
 * ends as 1-based line and 1-based byte column, in either order.
 */
export interface MinimapSelection {
  kind: 'char' | 'line' | 'block'
  anchor: [number, number]
  cursor: [number, number]
  // The `Visual` highlight's background, when the colour scheme sets one.
  color?: string
}

/**
 * One line's stretch of a selection in map columns. `toCol` null means the
 * selection runs on past the line's end, so the band reaches the map's edge.
 */
export interface SelectionSpan {
  line: number
  fromCol: number
  toCol: number | null
}

/** Splits a visual selection into one span per selected line, top to bottom. */
export function selectionSpans(selection: MinimapSelection): SelectionSpan[] {
  let start = selection.anchor
  let end = selection.cursor
  if (end[0] < start[0] || (end[0] === start[0] && end[1] < start[1])) {
    start = selection.cursor
    end = selection.anchor
  }
  const spans: SelectionSpan[] = []
  for (let line = start[0]; line <= end[0]; line++) {
    spans.push(spanForLine(selection, line, start, end))
  }
  return spans
}

/** The columns one line of a selection covers, given its ordered ends. */
function spanForLine(
  selection: MinimapSelection,
  line: number,
  start: [number, number],
  end: [number, number]
): SelectionSpan {
  if (selection.kind === 'line') {
    return { line, fromCol: 0, toCol: null }
  }
  if (selection.kind === 'block') {
    const left = Math.min(selection.anchor[1], selection.cursor[1])
    const right = Math.max(selection.anchor[1], selection.cursor[1])
    return { line, fromCol: left - 1, toCol: right }
  }
  let fromCol = 0
  if (line === start[0]) {
    fromCol = start[1] - 1
  }
  let toCol: number | null = null
  if (line === end[0]) {
    toCol = end[1]
  }
  return { line, fromCol, toCol }
}

/**
 * One round-trip for the minimap. The window view always, plus the row layout
 * in diff mode; buffer text and colours only when the buffer or its content
 * changed (changedtick is per-buffer, so the buffer number is part of the gate).
 *
 * The window is the text window the cursor is in, or when the cursor is in a
 * terminal, quickfix list or float, the one it came from: a `:terminal` split
 * above the file must not turn the file's minimap into the terminal's output.
 * Its id comes back as `win`, for scrolling that window from the map.
 *
 * While that window is in visual or select mode, `selection` carries the
 * selection: it only exists in the current window, so other windows have none.
 *
 * Colours come from whatever is colouring the buffer on screen: treesitter's
 * captures when its highlighter is running — every language tree, so injected
 * code is coloured too, and captures spanning lines split across them — and
 * the regex syntax groups otherwise, sampled per word.
 */
export const MINIMAP_VIEW_LUA = `
local prevTick, prevBuf = ...

-- Windows whose buffer is not text the minimap should stand for.
local SKIPPED_BUFTYPES = { terminal = true, quickfix = true, prompt = true }

local function is_text_window(win)
  if not vim.api.nvim_win_is_valid(win) then return false end
  if vim.api.nvim_win_get_config(win).relative ~= '' then return false end
  local buftype = vim.bo[vim.api.nvim_win_get_buf(win)].buftype
  return not SKIPPED_BUFTYPES[buftype]
end

-- The current window when it holds text, else the previous one, else the
-- first text window on the tab page, else the current window after all.
local function minimap_window()
  local current = vim.api.nvim_get_current_win()
  if is_text_window(current) then return current end
  local previous = vim.fn.win_getid(vim.fn.winnr('#'))
  if previous ~= 0 and is_text_window(previous) then return previous end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if is_text_window(win) then return win end
  end
  return current
end

local win = minimap_window()

-- Read before nvim_win_call: the selection belongs to the current window only.
local SELECTION_KINDS = {
  v = 'char', V = 'line', ['\\22'] = 'block',
  s = 'char', S = 'line', ['\\19'] = 'block',
}
local selection = nil
local selection_kind = SELECTION_KINDS[vim.fn.mode()]
if selection_kind and win == vim.api.nvim_get_current_win() then
  local anchor = vim.fn.getpos('v')
  local cursor = vim.fn.getpos('.')
  selection = {
    kind = selection_kind,
    anchor = { anchor[2], anchor[3] },
    cursor = { cursor[2], cursor[3] },
  }
  local visual = vim.api.nvim_get_hl(0, { name = 'Visual', link = false })
  if visual.bg then selection.color = string.format('#%06x', visual.bg) end
end

return vim.api.nvim_win_call(win, function()
local buf = vim.api.nvim_get_current_buf()
local total = vim.api.nvim_buf_line_count(buf)
local TREESITTER_LINE_LIMIT = 8000
local SYNTAX_LINE_LIMIT = 3000

-- The window's rows in diff mode: buffer lines, closed folds (negative) and
-- filler rows (0). Nil outside diff mode, where every line is its own row.
local function display_rows()
  if not vim.wo.diff then return nil end
  local rows = {}
  local lnum = 1
  while lnum <= total do
    for _ = 1, vim.fn.diff_filler(lnum) do rows[#rows + 1] = 0 end
    local fold_end = vim.fn.foldclosedend(lnum)
    if fold_end ~= -1 then
      rows[#rows + 1] = -lnum
      lnum = fold_end + 1
    else
      rows[#rows + 1] = lnum
      lnum = lnum + 1
    end
  end
  for _ = 1, vim.fn.diff_filler(total + 1) do rows[#rows + 1] = 0 end
  return rows
end

-- The 1-based row the window's first line is on, counting the filler rows
-- shown above it.
local function top_row(rows, view)
  local top = view.topline
  local fold_start = vim.fn.foldclosed(top)
  if fold_start ~= -1 then top = fold_start end
  for index, entry in ipairs(rows) do
    if math.abs(entry) == top and entry ~= 0 then
      return math.max(1, index - (view.topfill or 0))
    end
  end
  return 1
end

local color_cache = {}
-- The foreground of a highlight group, falling back through its parents
-- (@keyword.function.lua → @keyword.function → @keyword) the way the
-- treesitter highlighter resolves a capture.
local function color_for(group)
  if color_cache[group] ~= nil then return color_cache[group] end
  local name = group
  local color = false
  while name do
    local hl = vim.api.nvim_get_hl(0, { name = name, link = false })
    if hl and hl.fg then
      color = string.format('#%06x', hl.fg)
      break
    end
    name = name:match('^(.+)%.[^.]+$')
  end
  color_cache[group] = color
  return color
end

local function add_span(spans, lines, srow, scol, erow, ecol, color)
  local last = math.min(erow, total - 1)
  for row = srow, last do
    local from = 0
    if row == srow then from = scol end
    local to = #(lines[row + 1] or '')
    if row == erow then to = ecol end
    if to > from then table.insert(spans[row + 1], { from, to, color }) end
  end
end

local function treesitter_spans(lines)
  if not vim.treesitter.highlighter.active[buf] then return nil end
  if total > TREESITTER_LINE_LIMIT then return nil end
  local parser = vim.treesitter.get_parser(buf, nil, { error = false })
  if not parser then return nil end
  local spans = {}
  for i = 1, total do spans[i] = {} end
  pcall(function()
    -- Parse the whole buffer, not just the visible viewport, so every line
    -- gets highlight captures.
    parser:parse(true)
    parser:for_each_tree(function(tree, language_tree)
      local lang = language_tree:lang()
      local query = vim.treesitter.query.get(lang, 'highlights')
      if not query then return end
      for id, node in query:iter_captures(tree:root(), buf, 0, total) do
        local capture = query.captures[id]
        if capture ~= 'spell' and capture ~= 'nospell' and capture:sub(1, 1) ~= '_' then
          local color = color_for('@' .. capture .. '.' .. lang)
          if color then
            local srow, scol, erow, ecol = node:range()
            add_span(spans, lines, srow, scol, erow, ecol, color)
          end
        end
      end
    end)
  end)
  return spans
end

-- Regex syntax: one colour per word and per run of punctuation, read from
-- the syntax item at its first character.
local function syntax_spans(lines)
  if vim.bo[buf].syntax == '' then return nil end
  local spans = {}
  for i = 1, total do spans[i] = {} end
  for i = 1, math.min(total, SYNTAX_LINE_LIMIT) do
    local text = lines[i]
    for _, pattern in ipairs({ '()([%w_]+)', '()([^%w_%s]+)' }) do
      for start, chunk in text:gmatch(pattern) do
        local id = vim.fn.synIDtrans(vim.fn.synID(i, start, 1))
        local fg = vim.fn.synIDattr(id, 'fg#')
        if fg ~= '' then table.insert(spans[i], { start - 1, start - 1 + #chunk, fg }) end
      end
    end
  end
  return spans
end

local view = vim.fn.winsaveview()
local out = {
  view = view,
  win = win,
  tick = vim.b.changedtick,
  bufnr = buf,
  total = total,
  topline = vim.fn.line('w0'),
  botline = vim.fn.line('w$'),
  selection = selection
}
local rows = display_rows()
if rows then
  out.rows = rows
  out.topline = top_row(rows, view)
  out.botline = math.min(#rows, out.topline + vim.api.nvim_win_get_height(0) - 1)
end
if out.tick == prevTick and out.bufnr == prevBuf then return out end
out.lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
out.spans = treesitter_spans(out.lines) or syntax_spans(out.lines)
return out
end)
`

/** Scrolls the window the minimap stands for, which need not be the current one. */
export const MINIMAP_RESTORE_VIEW_LUA = `
local win, view = ...
if not vim.api.nvim_win_is_valid(win) then return end
vim.api.nvim_win_call(win, function() vim.fn.winrestview(view) end)
`
