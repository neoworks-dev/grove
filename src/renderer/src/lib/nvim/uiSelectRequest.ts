// Reading nvim's `grove_ui_select` notifications (see uiSelect.ts) into picker
// items. Kept free of the overlay store so it can be tested on its own.

export interface SelectEntry {
  // nvim's 1-based index into the items it was asked to choose from.
  index: number
  label: string
  // Why the choice can't be made here, for a code action the server offers
  // but can't apply; undefined when it can.
  disabled?: string
}

export interface SelectRequest {
  nvimId: string
  requestId: number
  prompt: string
  entries: SelectEntry[]
}

export interface SelectItem {
  id: string
  label: string
  description?: string
}

/** One entry of the notification, or null when it carries no label. */
function parseEntry(raw: unknown, index: number): SelectEntry | null {
  const data = (raw ?? {}) as { label?: unknown; disabled?: unknown }
  if (typeof data.label !== 'string') {
    return null
  }
  const entry: SelectEntry = { index, label: data.label }
  if (typeof data.disabled === 'string') {
    entry.disabled = data.disabled
  }
  return entry
}

/** The picker placeholder for nvim's prompt, without its trailing colon. */
function promptText(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return 'Select…'
  }
  return prompt.trim().replace(/:$/, '')
}

/** Reads a `grove_ui_select` notification, or null when it isn't one. */
export function parseSelectRequest(payload: unknown): SelectRequest | null {
  const event = payload as { id: string; method: string; args: unknown[] }
  if (event.method !== 'grove_ui_select') {
    return null
  }
  const data = (event.args?.[0] ?? {}) as { id?: unknown; prompt?: unknown; items?: unknown }
  if (typeof data.id !== 'number' || !Array.isArray(data.items)) {
    return null
  }
  const entries: SelectEntry[] = []
  data.items.forEach((raw, position) => {
    const entry = parseEntry(raw, position + 1)
    if (entry !== null) {
      entries.push(entry)
    }
  })
  return { nvimId: event.id, requestId: data.id, prompt: promptText(data.prompt), entries }
}

/**
 * The entries whose label contains every word of the query, usable ones first
 * and each group in nvim's order. A disabled entry carries its reason.
 */
export function selectItems(
  request: SelectRequest,
  matches: (text: string) => boolean
): SelectItem[] {
  const usable: SelectItem[] = []
  const disabled: SelectItem[] = []
  for (const entry of request.entries) {
    if (!matches(entry.label)) {
      continue
    }
    const item: SelectItem = { id: String(entry.index), label: entry.label }
    if (entry.disabled === undefined) {
      usable.push(item)
      continue
    }
    item.description = entry.disabled
    disabled.push(item)
  }
  return [...usable, ...disabled]
}
