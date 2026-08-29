// LSP references picker for the embedded Neovim editor. Neovim remains the LSP
// client, while Grove owns the multi-result UI so references use the same
// searchable list and source preview as ripgrep instead of a native quickfix
// window that is disconnected from Grove's tabs.

import {
  normalizeNvimReferences,
  referenceMatchesQuery,
  type NvimReference
} from './nvimReferences'
import {
  overlays,
  type OverlayItem,
  type OverlayPreviewContent,
  type OverlayToken
} from './overlays.svelte'
import { sessionByNvimId } from './nvim/registry'
import { store } from './store.svelte'

const OVERLAY_ID = 'lsp-references'
const CONTEXT_BEFORE = 8
const CONTEXT_AFTER = 8

// Ask the exact editor session that emitted `gr`. A synchronous LSP request is
// appropriate here: it runs inside Neovim while Grove's overlay is already open,
// and avoids leaking LSP connections or client ids across the process boundary.
const REFERENCES_LUA = `
local bufnr = vim.api.nvim_get_current_buf()
local clients = vim.lsp.get_clients({ bufnr = bufnr, method = 'textDocument/references' })
if vim.tbl_isempty(clients) then return {} end

local out = {}
for _, client in ipairs(clients) do
  local encoding = client.offset_encoding or 'utf-16'
  local params = vim.lsp.util.make_position_params(0, encoding)
  params.context = { includeDeclaration = true }
  local response = client:request_sync('textDocument/references', params, 3000, bufnr)
  for _, location in ipairs(response and response.result or {}) do
    local uri = location.uri or location.targetUri
    local range = location.range or location.targetSelectionRange or location.targetRange
    local start = range and range.start or nil
    local finish = range and range['end'] or start
    if uri and start and finish then
      out[#out + 1] = {
        path = vim.uri_to_fname(uri),
        uri = uri,
        line = start.line,
        col = start.character,
        endLine = finish.line,
        endCol = finish.character,
        encoding = encoding
      }
    end
  end
end
return out
`

// Let Neovim interpret the client-specific offset encoding when jumping. A raw
// LSP character offset is not necessarily a byte column, which nvim_win_set_cursor
// expects, so converting it in the renderer would misplace non-ASCII references.
const SHOW_REFERENCE_LUA = `
local reference = ...
local shown = vim.lsp.util.show_document({
  uri = reference.uri,
  range = {
    start = { line = reference.line, character = reference.col },
    ['end'] = { line = reference.endLine, character = reference.endCol }
  }
}, reference.encoding, { focus = true, reuse_win = true })
if shown then vim.cmd('normal! zz') end
return shown
`

function relativePath(path: string): string {
  const root = store.selectedWorktree?.path
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path
}

function toItem(reference: NvimReference): OverlayItem {
  const displayPath = relativePath(reference.path)
  return {
    id: `${reference.path}:${reference.line}:${reference.col}`,
    label: displayPath,
    description: `:${reference.line + 1}:${reference.col + 1}`,
    icon: `file:${displayPath}`,
    data: reference
  }
}

async function fetchReferences(nvimId: string): Promise<NvimReference[]> {
  try {
    const result = await window.workbench.nvim.request(nvimId, 'nvim_exec_lua', [
      REFERENCES_LUA,
      []
    ])
    return normalizeNvimReferences(result)
  } catch {
    return []
  }
}

class ReferencesStore {
  show(nvimId: string, symbol = ''): void {
    // One LSP request feeds every filter update while this picker is open.
    const pending = fetchReferences(nvimId)
    overlays.show({
      id: OVERLAY_ID,
      placeholder: symbol ? `References to ${symbol}…` : 'References…',
      debounceMs: 0,
      onQuery: async (query, emit, token) => {
        const found = await pending
        if (token.isCancelled) return
        emit(
          found.filter((reference) => referenceMatchesQuery(reference, query, symbol)).map(toItem),
          { replace: true }
        )
      },
      onPreview: async (item, token) => this.previewFor(item, token),
      onAccept: (picked) => this.jump(nvimId, picked[0])
    })
  }

  private async previewFor(
    item: OverlayItem,
    token: OverlayToken
  ): Promise<OverlayPreviewContent | null> {
    const reference = item.data as NvimReference
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId || token.isCancelled) return null
    try {
      const content = await window.workbench.files.read(worktreeId, reference.path)
      if (token.isCancelled || typeof content !== 'string') return null
      const all = content.split('\n')
      const from = Math.max(0, reference.line - CONTEXT_BEFORE)
      const lines = all
        .slice(from, reference.line + CONTEXT_AFTER + 1)
        .map((text, offset) => ({ n: from + offset + 1, text }))
      return {
        kind: 'excerpt',
        file: relativePath(reference.path),
        lines,
        highlightLine: reference.line + 1
      }
    } catch {
      return null
    }
  }

  private jump(nvimId: string, item: OverlayItem | undefined): void {
    if (!item) return
    const reference = item.data as NvimReference
    // Overlay items live in Svelte state and may therefore be proxies, which
    // Electron cannot structured-clone across IPC. Send an explicit plain DTO.
    const location: NvimReference = {
      path: reference.path,
      uri: reference.uri,
      line: reference.line,
      col: reference.col,
      endLine: reference.endLine,
      endCol: reference.endCol,
      encoding: reference.encoding
    }
    void window.workbench.nvim
      .request(nvimId, 'nvim_exec_lua', [SHOW_REFERENCE_LUA, [location]])
      .catch((error) => console.warn('Failed to open LSP reference', error))
      .finally(() => sessionByNvimId(nvimId)?.focus())
  }
}

export const references = new ReferencesStore()
