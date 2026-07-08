// Tree-sitter highlighting engine + CodeMirror bridge. Parses the document with
// a WASM grammar, runs its highlights query, and emits colored decorations. The
// grammar runtime and grammars are WASM (instantiated under CSP wasm-unsafe-eval);
// grammar bytes are fetched by the main process and loaded here.

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Parser, Language, Query, type Node } from 'web-tree-sitter'
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import { colorForCapture } from './treesitterColors'
import type { ThemePalette } from './themes'

// Don't tree-sitter enormous files (avoids blocking the UI thread).
const MAX_DOC = 500_000

let initPromise: Promise<void> | null = null
export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({ locateFile: () => runtimeWasmUrl })
  }
  return initPromise
}

// Load a grammar from raw wasm bytes or a (same-origin) URL. Caller must have
// awaited initTreeSitter() first.
export function loadGrammar(input: string | Uint8Array): Promise<Language> {
  return Language.load(input)
}

// Cache one mark decoration per color so repeated colors don't reallocate.
const markCache = new Map<string, Decoration>()
function markFor(color: string): Decoration {
  let mark = markCache.get(color)
  if (!mark) {
    mark = Decoration.mark({ attributes: { style: `color:${color}` } })
    markCache.set(color, mark)
  }
  return mark
}

interface ColoredRange {
  from: number
  to: number
  color: string
}

function decorationsFor(tree: { rootNode: Node }, query: Query, palette: ThemePalette): DecorationSet {
  const ranges: ColoredRange[] = []
  for (const capture of query.captures(tree.rootNode)) {
    const color = colorForCapture(capture.name, palette)
    if (!color) continue
    const from = capture.node.startIndex
    const to = capture.node.endIndex
    if (to > from) ranges.push({ from, to, color })
  }
  // RangeSetBuilder needs ascending `from`; wider ranges first at a tie so more
  // specific (narrower) captures nest inside and win the color.
  ranges.sort((a, b) => a.from - b.from || b.to - a.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of ranges) builder.add(range.from, range.to, markFor(range.color))
  return builder.finish()
}

// Build a CodeMirror extension that highlights via the given grammar + query.
export function treeSitterExtension(
  language: Language,
  highlightsScm: string,
  palette: ThemePalette
): Extension {
  const query = new Query(language, highlightsScm)

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private parser: Parser
      private tree: ReturnType<Parser['parse']>

      constructor(view: EditorView) {
        this.parser = new Parser()
        this.parser.setLanguage(language)
        this.tree = this.reparse(view.state.doc.toString())
        this.decorations = this.build()
      }

      private reparse(text: string): ReturnType<Parser['parse']> {
        if (text.length > MAX_DOC) return null
        return this.parser.parse(text)
      }

      private build(): DecorationSet {
        if (!this.tree) return Decoration.none
        return decorationsFor(this.tree, query, palette)
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged) return
        this.tree?.delete()
        this.tree = this.reparse(update.view.state.doc.toString())
        this.decorations = this.build()
      }

      destroy(): void {
        this.tree?.delete()
        this.parser.delete()
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
