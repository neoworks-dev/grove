<script lang="ts">
  // Markdown in a tone, as a title, as body text or as code.
  import { View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import Blocks from "../Blocks.svelte";
  import { toneColor } from "./look";
  import { blocks, str, tone as toneOf } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;

  const role = $derived(str(node, "role"));
  const size = $derived.by(() => {
    if (role === "title") return p.text.title + 3;
    return role === "code" ? p.text.code : p.text.body;
  });
  const tone = $derived(toneOf(node));
</script>

<View
  style={{
    color: tone === undefined ? undefined : toneColor(tone, p),
    fontSize: size,
    fontWeight: role === "title" ? 600 : undefined,
    fontFamily: role === "code" ? "mono" : undefined,
  }}
>
  <Blocks blocks={blocks(node)} {size} />
</View>
