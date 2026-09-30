// nvim's vim.ui.select, drawn as Grove's picker. The bundled config replaces
// vim.ui.select with a `grove_ui_select` notification carrying the items; the
// pick (or a cancel) goes back through grove_ui_select_done, which calls the
// caller's on_choice. Code actions are the main customer.

import { overlays, matchesQuery } from '../overlays.svelte'
import { parseSelectRequest, selectItems, type SelectRequest } from './uiSelectRequest'

/** Tells nvim what was picked: a 1-based index, or null for a cancel. */
function answer(request: SelectRequest, index: number | null): void {
  void window.workbench.nvim
    .request(request.nvimId, 'nvim_exec_lua', [
      'grove_ui_select_done(...)',
      [request.requestId, index]
    ])
    .catch(() => {})
}

/** Opens the picker for one select request. */
function showSelect(request: SelectRequest): void {
  overlays.show({
    id: `nvim-ui-select:${request.nvimId}:${request.requestId}`,
    placeholder: request.prompt,
    debounceMs: 0,
    onQuery: (query, emit) =>
      emit(
        selectItems(request, (text) => matchesQuery(text, query)),
        { replace: true }
      ),
    onAccept: (picked) => answer(request, Number(picked[0].id)),
    onCancel: () => answer(request, null)
  })
}

/** Answers every nvim's vim.ui.select with Grove's picker; returns the inverse. */
export function watchNvimSelect(): () => void {
  return window.workbench.on('event:nvim-notify', (payload) => {
    const request = parseSelectRequest(payload)
    if (request === null) {
      return
    }
    showSelect(request)
  })
}
