// clipboard.* routes: the system clipboard, as plain text. Main owns it
// because a plugin's page runs in a sandboxed frame and its worker has no
// clipboard at all; one route serves plugins and external apps alike.
// Writing and reading are separate scopes: writing replaces what the user
// copied, reading exposes it — whatever it was, from whichever app.

import { ApiError, type RouteRegistry } from '../registry'

// The system clipboard, as these routes use it (Electron's in the app).
export interface ClipboardDeps {
  writeText(text: string): void
  readText(): string
}

// Larger than any log a pane would copy, small enough not to hang the
// clipboard owner on a runaway call.
const MAX_TEXT_CHARS = 16 * 1024 * 1024

export function registerClipboardRoutes(registry: RouteRegistry, deps: ClipboardDeps): void {
  registry.register({
    method: 'clipboard.writeText',
    scope: 'clipboard.write',
    describe: () => 'copy text to the clipboard',
    handler: async (args) => {
      deps.writeText(textArgument(args.text))
    }
  })

  registry.register({
    method: 'clipboard.readText',
    scope: 'clipboard.read',
    describe: () => 'read the clipboard',
    handler: async () => deps.readText()
  })
}

/** The text to copy, checked: a string within the size limit. */
function textArgument(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('clipboard.writeText needs text: string', 'invalid')
  }
  if (value.length > MAX_TEXT_CHARS) {
    throw new ApiError(`clipboard.writeText takes at most ${MAX_TEXT_CHARS} characters`, 'invalid')
  }
  return value
}
