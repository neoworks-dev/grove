<script lang="ts">
  // Code shown outside the editor: a tool call's input, a file preview, a fence
  // in an agent message.
  //
  // Highlighting is asynchronous — a grammar has to load — so the text renders
  // plain on the first frame and gains colour when the tokens arrive. Nothing
  // waits on shiki, and a language it does not know stays plain rather than
  // blank.

  import { highlightCode, type HighlightedToken } from '../lib/highlight'
  import { store } from '../lib/store.svelte'

  let {
    code,
    language,
    class: className = ''
  }: {
    code: string
    /** A shiki language id, as `languageOfPath` gives; unknown ones render plain. */
    language: string | undefined
    class?: string
  } = $props()

  let lines = $state<HighlightedToken[][]>([])

  $effect(() => {
    const source = code
    const scheme = store.activeTheme.scheme
    let current = true
    lines = []
    void highlightCode(source, language, scheme).then((highlighted) => {
      if (current) lines = highlighted ?? []
    })
    return () => {
      current = false
    }
  })
</script>

{#if lines.length > 0}
  <pre class={className}>{#each lines as line, index (index)}<span class="block"
        >{#each line as token, tokenIndex (tokenIndex)}<span style:color={token.color}
          >{token.text}</span
        >{/each}</span
      >{/each}</pre>
{:else}
  <pre class={className}>{code}</pre>
{/if}
