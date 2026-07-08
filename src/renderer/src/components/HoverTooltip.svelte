<script lang="ts">
  // Body of the LSP hover tooltip: markdown-rendered type info inside the
  // NeoWorks FloatingScrollbar so long signatures scroll with the themed
  // floating bar. A flex shell gives the scrollbar a bounded height to fill.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { renderMarkdown } from '../lib/markdown'

  let { text }: { text: string } = $props()
  const html = $derived(renderMarkdown(text))
</script>

<div class="cm-lsp-hover-shell">
  <FloatingScrollbar class="cm-lsp-hover-scroll">
    <div class="cm-lsp-hover">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html html}
    </div>
  </FloatingScrollbar>
</div>
