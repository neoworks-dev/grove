<script lang="ts">
  // A braille spinner for work in progress, in the colour of the text around it.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { ticker } from "./ticker";

  $effect(() => ticker.join());
</script>

<Text>{ticker.frame}</Text>
