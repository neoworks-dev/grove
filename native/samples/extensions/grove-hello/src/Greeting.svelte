<!-- A line of text for the status bar, in the active theme's accent colour. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { colors } from "@grove/extension";

  interface Props {
    text: string;
  }

  let { text }: Props = $props();
</script>

<Text style={{ color: colors.accent }}>{text}</Text>
