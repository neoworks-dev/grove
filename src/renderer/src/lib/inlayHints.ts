// Inlay hints: shadowed inline annotations from the language server (inferred
// types, parameter names). Fetched for the visible range and rendered as widget
// decorations; refetched (debounced) as the document or viewport changes.

import { StateEffect, StateField, RangeSetBuilder, type Extension, type Text } from '@codemirror/state'
import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type { InlayHint } from 'vscode-languageserver-types'
import type { LspContext } from './lspClient'

const FETCH_DEBOUNCE_MS = 250

function offsetAt(doc: Text, line: number, character: number): number {
  const lineNumber = Math.min(Math.max(line + 1, 1), doc.lines)
  const target = doc.line(lineNumber)
  return Math.min(target.from + character, target.to)
}

function labelText(hint: InlayHint): string {
  if (typeof hint.label === 'string') return hint.label
  return hint.label.map((part) => part.value).join('')
}

class InlayWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly padLeft: boolean,
    readonly padRight: boolean
  ) {
    super()
  }

  eq(other: InlayWidget): boolean {
    return other.text === this.text && other.padLeft === this.padLeft && other.padRight === this.padRight
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-inlay-hint'
    // Hair spaces give the padding the server requests without real whitespace.
    span.textContent = (this.padLeft ? ' ' : '') + this.text + (this.padRight ? ' ' : '')
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

const setInlayHints = StateEffect.define<DecorationSet>()

const inlayHintsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    // Keep existing hints roughly positioned across edits until the refetch.
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setInlayHints)) return effect.value
    }
    return value
  },
  provide(field) {
    return EditorView.decorations.from(field)
  }
})

function hintsToDecorations(doc: Text, hints: InlayHint[]): DecorationSet {
  const placed = hints
    .map((hint) => ({ hint, offset: offsetAt(doc, hint.position.line, hint.position.character) }))
    .sort((a, b) => a.offset - b.offset)
  const builder = new RangeSetBuilder<Decoration>()
  for (const { hint, offset } of placed) {
    builder.add(
      offset,
      offset,
      Decoration.widget({
        widget: new InlayWidget(labelText(hint), Boolean(hint.paddingLeft), Boolean(hint.paddingRight)),
        side: 1
      })
    )
  }
  return builder.finish()
}

export function inlayHints(context: LspContext): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      private token = 0

      constructor(view: EditorView) {
        this.schedule(view)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) this.schedule(update.view)
      }

      private schedule(view: EditorView): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.fetch(view), FETCH_DEBOUNCE_MS)
      }

      private async fetch(view: EditorView): Promise<void> {
        const startLine = view.state.doc.lineAt(view.viewport.from)
        const endLine = view.state.doc.lineAt(view.viewport.to)
        const range = {
          start: { line: startLine.number - 1, character: 0 },
          end: { line: endLine.number - 1, character: endLine.length }
        }
        const mine = ++this.token
        const hints = await window.workbench.lsp
          .inlayHints(context.worktreeId, context.language, context.uri, range)
          .catch(() => [])
        // A newer fetch superseded this one.
        if (mine !== this.token) return
        view.dispatch({ effects: setInlayHints.of(hintsToDecorations(view.state.doc, hints)) })
      }

      destroy(): void {
        if (this.timer) clearTimeout(this.timer)
      }
    }
  )
  return [inlayHintsField, plugin]
}
