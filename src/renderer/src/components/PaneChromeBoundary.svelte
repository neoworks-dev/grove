<script lang="ts">
  // Hides the enclosing pane's window controls from what it wraps. A pane that
  // hosts other pane types inside itself (the bottom panel's tabs) shows the
  // controls once, in its own header; the hosted bodies must not claim them.
  import type { Snippet } from 'svelte'
  import { providePaneChrome } from '../lib/paneChrome.svelte'

  let { children }: { children: Snippet } = $props()

  providePaneChrome(null)
</script>

{@render children()}
