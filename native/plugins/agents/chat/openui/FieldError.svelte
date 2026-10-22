<script lang="ts">
  // The message a failed field shows when no FormControl is there to show it.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { UiNode } from "@suite/protocol/types";
  import { neouiPalette } from "./look";
  import { inControl } from "./formcontext";
  import { str } from "./props";

  let { node }: { node: UiNode } = $props();
  const p = neouiPalette;
  const alone = !inControl();
</script>

{#if alone && str(node, "error")}
  <Text style={{ color: p.danger, fontSize: p.text.body - 1 }}>{str(node, "error")}</Text>
{/if}
