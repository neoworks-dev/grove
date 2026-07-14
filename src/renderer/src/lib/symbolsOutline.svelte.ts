// Symbol outline — the canonical overlay listing the current buffer's LSP
// document symbols (aerial/symbols-outline replacement). Data is fetched from
// the focused editor's nvim session over RPC; accepting a symbol jumps the
// cursor to it.

import { overlays, matchesQuery, type OverlayItem } from './overlays.svelte'
import { activeNvimSession } from './nvim/registry'
import { layout } from './layout.svelte'

const OVERLAY_ID = 'symbols'

// LSP SymbolKind → short label. Numeric per the LSP spec.
const KIND_LABEL: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class',
  6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string',
  16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key',
  21: 'null', 22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator',
  26: 'type-param'
}

interface RawSymbol {
  name: string
  kind: number
  line: number // 0-based
  col: number // 0-based
  depth: number
}

// Collect the buffer's document symbols, flattened depth-first. Handles both the
// hierarchical DocumentSymbol shape and the flat SymbolInformation shape.
const SYMBOLS_LUA = `
local bufnr = vim.api.nvim_get_current_buf()
if vim.tbl_isempty(vim.lsp.get_clients({ bufnr = bufnr })) then return {} end
local params = { textDocument = vim.lsp.util.make_text_document_params(bufnr) }
local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/documentSymbol', params, 1500)
local out = {}
local function walk(items, depth)
  for _, item in ipairs(items or {}) do
    local range = item.selectionRange or item.range or (item.location and item.location.range)
    local line, col = 0, 0
    if range then line = range.start.line; col = range.start.character end
    out[#out + 1] = { name = item.name, kind = item.kind, line = line, col = col, depth = depth }
    if item.children then walk(item.children, depth + 1) end
  end
end
if responses then
  for _, response in pairs(responses) do
    if response.result then walk(response.result, 0) end
  end
end
return out
`

async function fetchSymbols(): Promise<RawSymbol[]> {
  const id = activeNvimSession()?.id
  if (!id) return []
  try {
    const result = await window.workbench.nvim.request(id, 'nvim_exec_lua', [SYMBOLS_LUA, []])
    return Array.isArray(result) ? (result as RawSymbol[]) : []
  } catch {
    return []
  }
}

function toItem(symbol: RawSymbol, index: number): OverlayItem {
  const indent = '  '.repeat(symbol.depth)
  return {
    id: `${index}:${symbol.line}:${symbol.col}`,
    label: `${indent}${symbol.name}`,
    detail: KIND_LABEL[symbol.kind] ?? 'symbol',
    data: symbol
  }
}

class SymbolsOutlineStore {
  private symbols: RawSymbol[] = []

  async show(): Promise<void> {
    this.symbols = await fetchSymbols()
    overlays.show({
      id: OVERLAY_ID,
      placeholder: 'Symbols…',
      debounceMs: 0,
      onQuery: (query, emit) => {
        const items = this.symbols
          .map(toItem)
          .filter((item) => matchesQuery(`${item.label} ${item.detail}`, query))
        emit(items, { replace: true })
      },
      onAccept: (picked) => this.jump(picked[0])
    })
  }

  private jump(item: OverlayItem | undefined): void {
    if (!item) return
    const session = activeNvimSession()
    const symbol = item.data as RawSymbol
    if (!session?.id) return
    layout.showCenterPane('nvim')
    // nvim_win_set_cursor row is 1-based; LSP line is 0-based.
    void window.workbench.nvim
      .request(session.id, 'nvim_win_set_cursor', [0, [symbol.line + 1, symbol.col]])
      .then(() => session.focus())
  }

  toggle(): void {
    if (overlays.isOpen(OVERLAY_ID)) {
      overlays.cancel()
      return
    }
    void this.show()
  }
}

export const symbolsOutline = new SymbolsOutlineStore()
