<script lang="ts">
  // An extension's own UI, rendered from nib's declarative UiNode vocabulary.
  //
  // The extension says what it wants shown, not what it looks like — so a node
  // kind grove has not implemented falls back to its `fallbackText` rather than
  // failing, which is what lets nib grow the vocabulary without breaking us.

  import { renderMarkdown } from '../../../../lib/markdown'
  import type { UiNode, UiTone } from '../../../../lib/nib/types'
  import AgentSurface from './AgentSurface.svelte'

  let { node }: { node: UiNode } = $props()

  const TONE_CLASS: Record<UiTone, string> = {
    normal: 'text-default',
    muted: 'text-dim',
    success: 'text-green',
    warning: 'text-amber',
    danger: 'text-red'
  }

  function toneClass(tone: UiTone | undefined): string {
    return TONE_CLASS[tone ?? 'normal']
  }

  // Read before the branch: once every known kind has been ruled out the node
  // narrows to `never`, and the fallback is exactly the case nib added a kind we
  // have not implemented yet.
  const fallback = $derived(node.fallbackText ?? '')
</script>

{#if node.kind === 'stack'}
  <div class="mb-2 flex flex-col gap-1">
    {#each node.children as child, index (index)}
      <AgentSurface node={child} />
    {/each}
  </div>
{:else if node.kind === 'text'}
  <p class="mb-1 whitespace-pre-wrap text-2xs {toneClass(node.tone)}">{node.text}</p>
{:else if node.kind === 'markdown'}
  <div class="agent-markdown prose mb-2 max-w-none text-xs text-default">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html renderMarkdown(node.text)}
  </div>
{:else if node.kind === 'code'}
  <pre
    class="mb-2 max-h-60 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted"
    data-language={node.language}>{node.text}</pre>
{:else if node.kind === 'list'}
  <ul class="mb-2 list-disc pl-4">
    {#each node.items as entry, index (index)}
      <li class="text-2xs text-muted">{entry}</li>
    {/each}
  </ul>
{:else if node.kind === 'keyValue'}
  <dl class="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
    {#each node.entries as entry, index (index)}
      <dt class="text-2xs text-dim">{entry.key}</dt>
      <dd class="truncate font-mono text-2xs text-muted">{entry.value}</dd>
    {/each}
  </dl>
{:else if node.kind === 'table'}
  <div class="mb-2 overflow-x-auto">
    <table class="w-full text-left text-2xs">
      <thead>
        <tr>
          {#each node.columns as column, index (index)}
            <th class="border-b border-line pb-0.5 pr-3 font-medium text-dim">{column}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each node.rows as row, rowIndex (rowIndex)}
          <tr>
            {#each row as cell, cellIndex (cellIndex)}
              <td class="truncate pr-3 font-mono text-muted">{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if node.kind === 'badge'}
  <span
    class="mb-1 mr-1 inline-block rounded border border-line px-1.5 py-0.5 text-2xs {toneClass(
      node.tone
    )}">{node.text}</span
  >
{:else if node.kind === 'divider'}
  <hr class="my-2 border-line" />
{:else if fallback}
  <p class="mb-1 whitespace-pre-wrap text-2xs text-dim">{fallback}</p>
{/if}
