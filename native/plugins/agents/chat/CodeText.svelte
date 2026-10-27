<script lang="ts">
  // One line of code: plain, or in the colours the host's highlighter found for it.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { Run } from "../highlight";

  let { text, runs, style }: { text: string; runs?: readonly Run[]; style?: Record<string, unknown> } = $props();
</script>

<Text pre {style}>{#if runs === undefined}{text}{:else}{#each runs as run}<Text style={{ color: run.color, fontWeight: run.bold ? "bold" : undefined, italic: run.italic }}>{run.text}</Text>{/each}{/if}</Text>
