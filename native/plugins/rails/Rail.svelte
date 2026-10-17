<!--
  A vertical rail sitting on the canvas: the left activity bar and the right pane rail are the
  same component. What it holds is the caller's `children`, one `RailButton` per entry.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import { size } from "../theme/tokens";

  let { children }: { children: Snippet } = $props();
</script>

<View style={{ width: size.railWidth, shrink: 0, align: "center", gap: 4, paddingY: 8 }}>
  {@render children()}
</View>
