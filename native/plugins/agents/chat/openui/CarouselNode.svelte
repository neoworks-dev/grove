<script lang="ts">
  // Slides side by side, as many as fit (at most `visible`), with `‹ 2–3/5 ›` under them. It is a
  // stop of the keyboard: Left and Right scroll one slide, Home and End go to the ends, Enter goes
  // on round. The last slide can be the first in view, so scrolling never stalls.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import Cells from "./Cells.svelte";
  import { useDoc } from "./context";
  import Focus from "./Focus.svelte";
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

  function key(event: KeyEvent): void {
    if (event.key === "ArrowLeft") go(first - 1);
    else if (event.key === "ArrowRight") go(first + 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(count - 1);
    else if (event.key === "Enter" || event.key === " ") go(first + 1 >= count ? 0 : first + 1);
    else return;
    event.preventDefault();
  }
</script>

{#if count <= 1}
  <Cells {items} columns={1} {width} {gap} {path} />
{:else}
  <View style={{ gap: 8 }}>
    <Cells items={slides} columns={Math.max(1, shown)} {width} {gap} {path} />
    <Focus id={path} onkey={key} style={{ direction: "row", align: "center", justify: "center", gap: 10, paddingY: 2, radius: p.radius.s }}>
      {#snippet children(focused)}
        <View
          onpress={() => go(first - 1)}
          style={{ size: 26, align: "center", justify: "center", radius: 13, color: first > 0 ? p.accent : p.border, cursor: first > 0 ? "pointer" : undefined, background: focused ? p.hover : undefined }}
          hover={{ background: p.hover }}
        >
          <Text style={{ fontSize: 16 }}>‹</Text>
        </View>
        <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{slideLabel(win, count)}</Text>
        <View
          onpress={() => go(first + 1)}
          style={{ size: 26, align: "center", justify: "center", radius: 13, color: first < count - 1 ? p.accent : p.border, cursor: first < count - 1 ? "pointer" : undefined, background: focused ? p.hover : undefined }}
          hover={{ background: p.hover }}
        >
          <Text style={{ fontSize: 16 }}>›</Text>
        </View>
      {/snippet}
    </Focus>
  </View>
{/if}
