<!-- A status item that shows a line of text, optionally pressable. The simplest item there is. -->
<script lang="ts">
  import { Button, Text } from "@neoworks/svelte-gpui/ui";
  import { colors, radius } from "../theme/tokens";

  interface Props {
    text: string;
    onpress?: () => void;
  }

  let { text, onpress }: Props = $props();
</script>

{#if onpress}
  <Button style={{ paddingX: 4, radius: radius.sm, transition: 120 }} hover={{ background: colors.hover, color: colors.text }} {onpress}>
    <Text>{text}</Text>
  </Button>
{:else}
  <Text>{text}</Text>
{/if}
