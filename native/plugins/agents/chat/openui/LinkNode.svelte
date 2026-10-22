<script lang="ts">
  // A link: opened in the system's browser when pressed.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();
  const url = $derived(str(node, "url") ?? "");
</script>

<View onpress={() => doc.open(url)} style={{ alignSelf: "start", cursor: "pointer" }}>
  <Text style={{ color: p.accent, underline: true }}>{str(node, "text") || url}</Text>
</View>
