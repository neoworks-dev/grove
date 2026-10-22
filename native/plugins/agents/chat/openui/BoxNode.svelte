<script lang="ts">
  // A generic container: its children in a column or a row like a Stack's, inside padding, a
  // frame in a tone and a wash of a tone. Its own width is the parent's business (a share, fill or
  // fit: Kids and StackNode); this draws at the width it is given.
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { UiNode } from "@suite/protocol/types";
  import { neouiPalette } from "./look";
  import { tint, toneColor } from "./look";
  import { bool, list, str, tone as toneOf } from "./props";
  import StackNode from "./StackNode.svelte";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width, fill: grow = false }: NodeProps = $props();
  const p = neouiPalette;

  const PAD: Record<string, number> = { none: 0, s: 8, m: 14, l: 20 };
  const pad = $derived(PAD[str(node, "pad") ?? "none"] ?? 0);
  const border = $derived(toneOf(node, "border"));
  const wash = $derived(toneOf(node, "fill"));
  const frame = $derived(border === undefined ? 0 : 1);
  const inner = $derived(Math.max(0, width - 2 * (pad + frame)));
  const rounded = $derived(bool(node, "rounded") === true);
  /** The children as a Stack lays them out, which they keep their paths under. */
  const stack = $derived<UiNode>({
    component: "Stack",
    props: {
      children: list(node, "children"),
      direction: str(node, "dir") ?? "column",
      gap: str(node, "gap") ?? "s",
      wrap: bool(node, "wrap"),
      align: str(node, "align"),
      justify: str(node, "justify"),
    },
  });
</script>

<View
  style={{
    background: wash === undefined ? undefined : tint(p, toneColor(wash, p), 16),
    borderWidth: frame,
    borderColor: border === undefined ? undefined : toneColor(border, p),
    radius: rounded ? p.radius.m : 0,
    padding: pad,
    grow: grow ? 1 : undefined,
  }}
>
  <StackNode node={stack} {path} width={inner} />
</View>
