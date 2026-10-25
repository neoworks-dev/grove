<!--
  A body or comment, drawn as the chat draws what an agent writes: the markdown is parsed into
  blocks once per text and drawn by the chat's own `Blocks`.
-->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import Blocks from "../agents/chat/Blocks.svelte";
  import { colors, fontSize } from "../theme/tokens";
  import { parseMarkdown } from "./markdown";

  interface Props {
    text: string;
    /** What to say when there is none. */
    empty?: string;
  }

  let { text, empty = "No description provided." }: Props = $props();

  const blocks = $derived(parseMarkdown(text));
</script>

{#if text.trim() === ""}
  <Text style={{ fontSize: fontSize.xs, color: colors.dim, italic: true }}>{empty}</Text>
{:else}
  <Blocks {blocks} size={13} />
{/if}
