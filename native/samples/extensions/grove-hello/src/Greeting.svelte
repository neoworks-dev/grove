<!-- A line of text for the status bar, in one of the active theme's colours. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { colors } from "@grove/extension";

  interface Props {
    text: string;
    /** `accent`, `green` or `muted`. */
    tone: string;
  }

  let { text, tone }: Props = $props();

  /** The theme colour for the tone; the accent for a tone it does not know. */
  function colorOf(name: string): string {
    if (name === "green") {
      return colors.green;
    }
    if (name === "muted") {
      return colors.muted;
    }
    return colors.accent;
  }
</script>

<Text style={{ color: colorOf(tone) }}>{text}</Text>
