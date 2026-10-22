<script lang="ts">
  // Slides side by side, as many as fit (at most `visible`), with `‹ 2–3/5 ›` under them. The last
  // slide can be the first in view, so scrolling never stalls.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import Cells from "./Cells.svelte";
  import { useDoc } from "./context";
  import { slideLabel, slidesFor, slideWindow, visibleOf } from "./layout";
  import { nodes } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const gap = 12;
  const items = $derived(nodes(node, "children").map((child, index) => ({ node: child, index })));
  const count = $derived(items.length);
  const shown = $derived(slidesFor(width, count, visibleOf(node), gap));
  const first = $derived(Math.min(doc.view.slides[path] ?? 0, Math.max(0, count - 1)));
  const win = $derived(slideWindow(first, shown, count));
  const slides = $derived(items.slice(win.from, win.to));

  function go(to: number): void {
    doc.view.slides[path] = Math.min(count - 1, Math.max(0, to));
  }
</script>

{#if count <= 1}
  <Cells {items} columns={1} {width} {gap} {path} />
{:else}
  <View style={{ gap: 8 }}>
    <Cells items={slides} columns={Math.max(1, shown)} {width} {gap} {path} />
    <View style={{ direction: "row", align: "center", justify: "center", gap: 10, paddingY: 2, radius: p.radius.s }}>
        <View
          onpress={() => go(first - 1)}
          style={{ size: 26, align: "center", justify: "center", radius: 13, color: first > 0 ? p.accent : p.border, cursor: first > 0 ? "pointer" : undefined }}
          hover={{ background: p.hover }}
        >
          <Text style={{ fontSize: 16 }}>‹</Text>
        </View>
        <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{slideLabel(win, count)}</Text>
        <View
          onpress={() => go(first + 1)}
          style={{ size: 26, align: "center", justify: "center", radius: 13, color: first < count - 1 ? p.accent : p.border, cursor: first < count - 1 ? "pointer" : undefined }}
          hover={{ background: p.hover }}
        >
          <Text style={{ fontSize: 16 }}>›</Text>
        </View>
    </View>
  </View>
{/if}
