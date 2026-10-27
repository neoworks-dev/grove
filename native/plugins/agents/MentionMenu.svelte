<!--
  The `@` list above the input: the files the word being typed could name. The input keeps the
  keyboard (Up, Down, Tab and Enter reach it through its key handler), so this only draws and takes
  presses. Ported from neo term's draw_mentions (apps/term).
-->
<script lang="ts">
  import { Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Layout, ScrollPosition } from "@neoworks/svelte-gpui/ui";
  import type { ComposerModel } from "./composerModel";
  import type { Candidate } from "./mention";
  import { palette } from "./palette";

  interface Props {
    model: ComposerModel;
    /** A file was picked with the pointer. */
    onchosen: (candidate: Candidate) => void;
  }

  let { model, onchosen }: Props = $props();

  const p = palette;
  const ROW = 26;
  const VISIBLE_ROWS = 8;

  const matches = $derived(model.mentionMatches());
  const selected = $derived(model.selected());

  let scroller: ReturnType<typeof Scroll> | undefined = $state();
  let top = 0;
  let viewport = 0;

  // Scrolls the highlighted row into view.
  $effect(() => {
    const start = selected * ROW;
    if (viewport === 0) {
      return;
    }
    if (start < top) {
      scroller?.scrollTo(start);
    } else if (start + ROW > top + viewport) {
      scroller?.scrollTo(start + ROW - viewport);
    }
  });
</script>

<View
  style={{
    background: p.surface,
    borderWidth: 1,
    borderColor: p.border,
    radius: 8,
    padding: 4,
    shadow: { y: 8, blur: 24, color: "#00000099" },
  }}
>
  <Scroll
    bind:this={scroller}
    style={{ maxHeight: ROW * VISIBLE_ROWS }}
    onscroll={(position: ScrollPosition) => (top = position.y)}
    onlayout={(box: Layout) => (viewport = box.height)}
  >
    {#each matches as candidate, index (candidate.path)}
      <View
        style={{
          direction: "row",
          align: "center",
          gap: p.space.m,
          height: ROW,
          shrink: 0,
          paddingX: p.space.m,
          radius: 5,
          background: index === selected ? p.band : "transparent",
        }}
        onhover={(hovered: boolean) => hovered && model.select(index)}
        onpress={() => onchosen(candidate)}
      >
        <Text style={{ color: p.accent, shrink: 0 }}>@</Text>
        <Text style={{ color: candidate.dir ? p.muted : p.fg, flex: 1, minWidth: 0, truncate: true }}>{candidate.path}</Text>
      </View>
    {/each}
  </Scroll>
</View>
