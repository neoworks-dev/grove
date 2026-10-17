<script lang="ts">
  // The runs of one paragraph: nested `Text`s, so the paragraph still wraps as a whole. No
  // white space between the tags: it would show as a space between two runs.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { Span } from "@suite/protocol/types";
  import { linkHint, spanStyle } from "./runs";
  import { palette } from "../palette";

  let { spans }: { spans: readonly Span[] } = $props();
  const p = palette;
</script>

{#each spans as span}<Text style={spanStyle(span, p)}>{span.text}</Text>{#if linkHint(span)}<Text style={{ color: p.muted }}>{` (${linkHint(span)})`}</Text>{/if}{/each}
