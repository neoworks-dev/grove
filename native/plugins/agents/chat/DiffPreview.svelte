<script lang="ts">
  // What a call changed, under its row: the changed lines on their red and green bands, cut to a
  // few until the call is opened. The row above names the file, so no file name heads the lines.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { DiffComponent } from "@suite/protocol/types";
  import { lineHeightOf } from "./components";
  import { clip } from "./diff";
  import { diffColors } from "./diffColors";
  import { palette } from "../palette";

  /** Lines shown before "… +N lines". */
  const PREVIEW_DIFF_LINES = 6;

  let { diff }: { diff: DiffComponent } = $props();

  const p = palette;
  const colors = $derived(diffColors(p));
  const lineHeight = $derived(lineHeightOf(p.text.code));
  const clipped = $derived(clip(diff.lines.filter((line) => line.kind !== "hunk"), PREVIEW_DIFF_LINES));

  /** The colour behind a line: red or green for a change, none for context. */
  function background(kind: string): string | undefined {
    if (kind === "add") {
      return colors.add;
    }
    if (kind === "remove") {
      return colors.remove;
    }
    return undefined;
  }

  /** The sign in front of a line. */
  function sign(kind: string): string {
    if (kind === "add") {
      return "+";
    }
    if (kind === "remove") {
      return "−";
    }
    return " ";
  }
</script>

<View style={{ radius: 4, overflow: "hidden" }}>
  {#each clipped.shown as line}
    <View style={{ direction: "row", paddingX: p.space.s, background: background(line.kind) }}>
      <Text style={{ width: 14, fontFamily: "mono", fontSize: p.text.code, lineHeight, color: p.muted }}>{sign(line.kind)}</Text>
      <Text pre style={{ flex: 1, minWidth: 0, truncate: true, fontFamily: "mono", fontSize: p.text.code, lineHeight }}>{line.text}</Text>
    </View>
  {/each}
  {#if clipped.hidden > 0}
    <View style={{ paddingX: p.space.s }}>
      <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted }}>… +{clipped.hidden} lines</Text>
    </View>
  {/if}
</View>
