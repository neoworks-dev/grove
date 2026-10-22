<script lang="ts">
  // A link, drawn as one. Opening it in the system's browser comes with the host's `open_url`.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const url = $derived(str(node, "url") ?? "");
</script>

<View style={{ alignSelf: "start" }}>
  <Text style={{ color: p.accent, underline: true }}>{str(node, "text") || url}</Text>
</View>
