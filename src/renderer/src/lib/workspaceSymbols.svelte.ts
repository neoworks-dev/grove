// Workspace symbol search — the overlay for jumping to any function/class/etc
// across the repo, not just the current buffer (the outline's sibling). Each
// keystroke runs an LSP `workspace/symbol` query through the focused editor's
// nvim session; accepting opens the file at the symbol.

import { overlays, type OverlayItem, type OverlayPreviewContent } from './overlays.svelte'
import { KIND_LABEL } from './symbolsOutline.svelte'
import { activeNvimSession } from './nvim/registry'
import { layout } from './layout.svelte'
import { store, openFileAtLine } from './store.svelte'

const OVERLAY_ID = 'workspace-symbols'

interface RawWorkspaceSymbol {
  name: string
  kind: number
  uri: string
  line: number // 0-based
  col: number // 0-based
  container?: string
}

// Query the buffer's LSP clients for workspace symbols. Handles the flat
// SymbolInformation shape (location) and the WorkspaceSymbol shape where the
// location may lack a range until resolved.
const WORKSPACE_SYMBOLS_LUA = `
local query = ...
local bufnr = vim.api.nvim_get_current_buf()
if vim.tbl_isempty(vim.lsp.get_clients({ bufnr = bufnr })) then return {} end
local responses = vim.lsp.buf_request_sync(bufnr, 'workspace/symbol', { query = query }, 2000)
local out = {}
if responses then
  for _, response in pairs(responses) do
    for _, item in ipairs(response.result or {}) do
      local location = item.location or {}
      local range = location.range or {}
      local start = range.start or {}
      out[#out + 1] = {
        name = item.name,
        kind = item.kind,
        uri = location.uri or '',
        line = start.line or 0,
        col = start.character or 0,
        container = item.containerName
      }
    end
  end
end
return out
`

function pathOfUri(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''))
}

async function fetchSymbols(query: string): Promise<RawWorkspaceSymbol[]> {
  const id = activeNvimSession()?.id
  if (!id) return []
  try {
    const result = await window.workbench.nvim.request(id, 'nvim_exec_lua', [
      WORKSPACE_SYMBOLS_LUA,
      [query]
    ])
    return Array.isArray(result) ? (result as RawWorkspaceSymbol[]) : []
  } catch {
    return []
  }
}

function toItem(symbol: RawWorkspaceSymbol, index: number): OverlayItem {
  const path = pathOfUri(symbol.uri)
  const root = store.selectedWorktree?.path
  const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  return {
    id: `${index}:${path}:${symbol.line}`,
    label: symbol.name,
    description: KIND_LABEL[symbol.kind] ?? 'symbol',
    detail: `${relative}:${symbol.line + 1}`,
    icon: `file:${path.split('/').pop() ?? ''}`,
    data: symbol
  }
}

class WorkspaceSymbolsStore {
  show(): void {
    overlays.show({
      id: OVERLAY_ID,
      placeholder: 'Workspace symbols…',
      onQuery: async (query, emit, token) => {
        const symbols = await fetchSymbols(query)
        if (token.isCancelled) return
        emit(symbols.map(toItem), { replace: true })
      },
      onPreview: async (item, token) => this.previewFor(item, token.isCancelled),
      onAccept: (picked) => this.jump(picked[0])
    })
  }

  private async previewFor(
    item: OverlayItem,
    cancelled: boolean
  ): Promise<OverlayPreviewContent | null> {
    const symbol = item.data as RawWorkspaceSymbol
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId || cancelled) return null
    const path = pathOfUri(symbol.uri)
    try {
      const content = await window.workbench.files.read(worktreeId, path)
      if (typeof content !== 'string') return null
      const all = content.split('\n')
      const from = Math.max(0, symbol.line - 6)
      const lines = all
        .slice(from, symbol.line + 9)
        .map((text, offset) => ({ n: from + offset + 1, text }))
      return { kind: 'excerpt', file: path, lines, highlightLine: symbol.line + 1 }
    } catch {
      return null
    }
  }

  private jump(item: OverlayItem | undefined): void {
    if (!item) return
    const symbol = item.data as RawWorkspaceSymbol
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    layout.showCenterPane('nvim')
    openFileAtLine(worktreeId, pathOfUri(symbol.uri), symbol.line + 1)
  }

  toggle(): void {
    if (overlays.isOpen(OVERLAY_ID)) {
      overlays.cancel()
      return
    }
    this.show()
  }
}

export const workspaceSymbols = new WorkspaceSymbolsStore()
