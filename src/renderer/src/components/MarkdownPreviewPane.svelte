<script lang="ts">
  // Rendered Markdown preview of the active buffer. Being an Electron app, we can
  // render real HTML (tables, images) in a pane — a capability the terminal grid
  // can't match. Content re-reads from disk on buffer switch and fs changes.
  import { store } from '../lib/store.svelte'
  import { renderMarkdown } from '../lib/markdown'

  let html = $state('')
  let notice = $state('Open a Markdown file to preview it.')

  function isMarkdown(path: string): boolean {
    return /\.(md|markdown|mdx)$/i.test(path)
  }

  $effect(() => {
    const path = store.activeTabPath
    const worktreeId = store.selectedWorktreeId
    // Re-render when the file changes on disk (saves, agent edits).
    store.fsVersion[worktreeId ?? '']
    if (!path || !worktreeId) {
      html = ''
      notice = 'Open a Markdown file to preview it.'
      return
    }
    if (!isMarkdown(path)) {
      html = ''
      notice = 'Active file is not Markdown.'
      return
    }
    void (async () => {
      try {
        const text = await window.workbench.files.read(worktreeId, path)
        html = renderMarkdown(text)
      } catch (error) {
        html = ''
        notice = (error as Error).message
      }
    })()
  })
</script>

<div class="h-full overflow-auto bg-canvas">
  {#if html}
    <!-- doc-article.prose is the theme-aware prose styling from main.css. -->
    <div class="doc-article prose mx-auto max-w-3xl px-6 py-8">
      {@html html}
    </div>
  {:else}
    <p class="p-6 text-xs text-dim">{notice}</p>
  {/if}
</div>
