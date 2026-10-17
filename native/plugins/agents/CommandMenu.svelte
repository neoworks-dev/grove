<!--
  The `/` menu above the input: the commands that match what is typed. The input keeps the
  keyboard (Up, Down, Tab and Enter reach it through its key handler), so this only draws and
  takes presses. Ported from neoworks-harness apps/gui (plugins/composer).
-->
<script lang="ts">
  import { Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Layout, ScrollPosition } from "@neoworks/svelte-gpui/ui";
  import type { ComposerModel } from "./composerModel";
  import { palette } from "./palette";

  interface Props {
    model: ComposerModel;
    /** A command was picked with the pointer. */
    onchosen?: () => void;
  }

  let { model, onchosen }: Props = $props();

  const p = palette;
  const ROW = 28;
  const VISIBLE_ROWS = 8;

  const commands = $derived(model.commands());
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
    {#each commands as command, index (command.name)}
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
        onpress={() => {
          model.choose(command);
          onchosen?.();
        }}
      >
        <Text style={{ color: p.accent, shrink: 0 }}>/{command.name}</Text>
        {#if command.args}
          <Text style={{ color: p.muted, shrink: 0 }}>{command.args}</Text>
        {/if}
        <Text style={{ color: p.muted, flex: 1, minWidth: 0, truncate: true, textAlign: "right" }}>{command.desc}</Text>
      </View>
    {/each}
  </Scroll>
</View>
