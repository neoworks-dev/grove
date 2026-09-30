// The bash parser the renderer lays commands out with.
//
// tree-sitter runs as WebAssembly, which loads asynchronously, while a command
// is laid out inside a `$derived`. So the parser is loaded on first use and
// held in `$state`: until it is ready a command shows as it was written, and
// every layout that asked re-derives the moment it is.

import { Language, Parser } from 'web-tree-sitter'
import treeSitterWasmUrl from 'web-tree-sitter/tree-sitter.wasm?url'
import bashWasmUrl from 'tree-sitter-bash/tree-sitter-bash.wasm?url'
import { layoutShellCommand } from './shellFormat'

let parser = $state.raw<Parser | null>(null)
let loading: Promise<void> | null = null

/**
 * A shell command laid out for reading, from its syntax tree once the parser
 * has loaded and as written until then.
 */
export function formatShellCommand(command: string, inlineLimit?: number): string {
  const current = parser
  if (!current) {
    void loadParser()
    return layoutShellCommand(command, null, inlineLimit)
  }

  const tree = current.parse(command.trim())
  if (!tree) return layoutShellCommand(command, null, inlineLimit)
  try {
    return layoutShellCommand(command, tree.rootNode, inlineLimit)
  } finally {
    // Trees live in WebAssembly memory, which nothing collects for us.
    tree.delete()
  }
}

/** Load tree-sitter and the bash grammar, once. A failure leaves commands as written. */
function loadParser(): Promise<void> {
  if (loading !== null) return loading
  loading = createParser()
    .then((created) => {
      parser = created
    })
    .catch((error: unknown) => {
      console.warn('[shellSyntax] bash parser failed to load', error)
    })
  return loading
}

/** A parser set to bash. */
async function createParser(): Promise<Parser> {
  await Parser.init({ locateFile: () => treeSitterWasmUrl })
  const bash = await Language.load(bashWasmUrl)
  const created = new Parser()
  created.setLanguage(bash)
  return created
}
