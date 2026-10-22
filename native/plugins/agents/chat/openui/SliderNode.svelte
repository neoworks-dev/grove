<script lang="ts">
  // A number between `min` and `max`: a track with a thumb and the number beside it. Dragging or
  // pressing the track sets it, Left and Right move by the step, Home and End go to the ends.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent, PointerEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import Focus from "./Focus.svelte";
  import { share, sliderAt, snap } from "./form";
  import { num } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const min = $derived(num(node, "min") ?? 0);
  const max = $derived(num(node, "max") ?? 100);
  const step = $derived(num(node, "step") ?? 1);
  const raw = $derived(doc.value(node));
  const value = $derived(typeof raw === "number" ? snap(raw, min, max, step) : min);
  const off = $derived(doc.streaming);
  const track = $derived(Math.max(80, Math.min(width - 70, 320)));
  const at = $derived(Math.round(share(value, min, max) * (track - 16)));
  let dragging = false;
  $effect(() => doc.view.echoed(key, node.props["value"]));

  function set(to: number, soon: boolean): void {
    if (off || to === value) return;
    doc.input(node, to, { soon });
  }

  function key_(event: KeyEvent): void {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") set(snap(value - step, min, max, step), false);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") set(snap(value + step, min, max, step), false);
    else if (event.key === "Home") set(min, false);
    else if (event.key === "End") set(max, false);
    else return;
    event.preventDefault();
  }
</script>

<Focus id={key} disabled={off} onkey={key_} style={{ direction: "row", align: "center", gap: 12, opacity: off ? 0.6 : undefined }}>
  {#snippet children(focused)}
    <View
      ondown={(event: PointerEvent) => {
        dragging = true;
        set(sliderAt(event.x - 8, track - 16, min, max, step), true);
      }}
      onmove={(event: PointerEvent) => dragging && set(sliderAt(event.x - 8, track - 16, min, max, step), true)}
      onup={(event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        // The last position goes at once.
        doc.input(node, sliderAt(event.x - 8, track - 16, min, max, step));
      }}
      style={{ width: track, height: 24, justify: "center", cursor: off ? undefined : "pointer" }}
    >
      <View style={{ height: 4, radius: 2, background: p.raised, marginX: 8 }}>
        <View style={{ width: at, height: 4, radius: 2, background: p.accent }} />
      </View>
      <View
        style={{
          position: "absolute",
          left: at,
          top: 4,
          size: 16,
          radius: 8,
          background: p.fg,
          borderWidth: focused ? 3 : 0,
          borderColor: p.accent,
        }}
      />
    </View>
    <Text style={{ color: p.muted, minWidth: 36, fontFamily: "mono", fontSize: 12 }}>{value}</Text>
  {/snippet}
</Focus>
