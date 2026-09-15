// Syntax highlighting for the code fences inside rendered markdown.
//
// Only a fence that named its language is touched: ```ts says what it is, a bare
// ``` is usually output, a path or a snippet of prose, and guessing at it colours
// things that are not code.
//
// The markdown reaches the DOM through {@html}, so the fences cannot be wrapped
// in a component at authoring time — the same reason `floatingCodeScrollbars`
// next door is an action. Streaming replaces the rendered HTML constantly, hence
// the MutationObserver, and each block remembers the text it was coloured for so
// its own rewrite is not mistaken for new content.

import { highlightCode, isHighlightable } from './highlight'
import { store } from './store.svelte'

const LANGUAGE_PREFIX = 'language-'

/** Svelte action: colour every fence under `container` that named a language. */
export function highlightCodeFences(container: HTMLElement): { destroy: () => void } {
  let disposed = false

  function highlightAll(): void {
    for (const block of container.querySelectorAll<HTMLElement>('pre > code')) {
      void highlightBlock(block)
    }
  }

  async function highlightBlock(block: HTMLElement): Promise<void> {
    const language = languageOf(block)
    if (!isHighlightable(language)) return

    const code = block.textContent ?? ''
    if (block.dataset.highlighted === code) return

    const lines = await highlightCode(code, language, store.activeTheme.scheme)
    if (disposed || !lines || !block.isConnected) return
    // The text may have moved on while the grammar loaded.
    if ((block.textContent ?? '') !== code) return

    block.dataset.highlighted = code
    block.replaceChildren(paint(lines))
  }

  highlightAll()
  const observer = new MutationObserver(highlightAll)
  observer.observe(container, { childList: true, subtree: true, characterData: true })

  return {
    destroy(): void {
      disposed = true
      observer.disconnect()
    }
  }
}

/** The language a fence declared, as `renderMarkdown` writes it onto the element. */
function languageOf(block: HTMLElement): string | undefined {
  for (const name of block.classList) {
    if (name.startsWith(LANGUAGE_PREFIX)) return name.slice(LANGUAGE_PREFIX.length)
  }
  return undefined
}

/** Coloured runs as DOM, built node by node so nothing in the code is parsed as HTML. */
function paint(lines: Awaited<ReturnType<typeof highlightCode>>): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (!lines) return fragment

  lines.forEach((tokens, index) => {
    if (index > 0) fragment.append('\n')
    for (const token of tokens) {
      const span = document.createElement('span')
      span.style.color = token.color
      span.textContent = token.text
      fragment.append(span)
    }
  })
  return fragment
}
