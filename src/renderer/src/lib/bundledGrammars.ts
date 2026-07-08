// Bundled tree-sitter grammars loaded at startup (the engine prototype). The
// remote extensions catalog (later phase) adds more grammars the same way:
// load the wasm, then register a high-priority highlighter provider whose
// build() colors with the current theme palette. JSON proves the bridge; its
// highlights query is inlined (queries for other grammars arrive via the catalog).

import { registerHighlighter } from './highlighters'
import { initTreeSitter, loadGrammar, treeSitterExtension } from './treesitter'
import { paletteFor, currentThemeName } from './themes'
import jsonWasmUrl from 'tree-sitter-wasms/out/tree-sitter-json.wasm?url'

const JSON_HIGHLIGHTS = `
(pair key: (string) @property)
(pair value: (string) @string)
(array (string) @string)
(number) @number
[(true) (false) (null)] @constant.builtin
(comment) @comment
["{" "}" "[" "]" "," ":"] @punctuation
`

interface BundledGrammar {
  id: string
  extensions: string[]
  wasmUrl: string
  highlights: string
}

const BUNDLED: BundledGrammar[] = [
  { id: 'json', extensions: ['json', 'jsonc'], wasmUrl: jsonWasmUrl, highlights: JSON_HIGHLIGHTS }
]

export async function initBundledGrammars(): Promise<void> {
  try {
    await initTreeSitter()
  } catch (error) {
    console.error('tree-sitter init failed', error)
    return
  }
  for (const grammar of BUNDLED) {
    try {
      const language = await loadGrammar(grammar.wasmUrl)
      registerHighlighter({
        id: grammar.id,
        extensions: grammar.extensions,
        priority: 100,
        // Rebuilt on each language reconfigure, so it tracks the active theme.
        build: () => treeSitterExtension(language, grammar.highlights, paletteFor(currentThemeName()))
      })
    } catch (error) {
      console.error(`grammar load failed: ${grammar.id}`, error)
    }
  }
}
