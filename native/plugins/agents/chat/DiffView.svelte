<script lang="ts">
  // A diff in the chat: unified, with the added and removed colouring and line numbers. Cut to a
  // few lines unless expanded.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { DiffComponent } from "@suite/protocol/types";
  import { lineHeightOf } from "./components";
  import { clip, diffStats, gutterWidth } from "./diff";
  import { palette } from "../palette";
  import { diffColors } from "./diffColors";

  interface Props {
    diff: DiffComponent;
    /** Lines to show before "… N more lines"; all (up to a cap) when absent. */
    limit?: number;
  }

  /** The most lines drawn in the chat. */
  const CAP = 400;

  let { diff, limit }: Props = $props();
  const p = palette;
  const colors = $derived(diffColors(p));

  const stats = $derived(diffStats(diff.lines));
  const clipped = $derived(clip(diff.lines, limit ?? CAP));
  const numberWidth = $derived(Math.round(gutterWidth(diff.lines) * p.text.code * 0.62) + 12);
  const lineHeight = $derived(lineHeightOf(p.text.code));

  function mark(kind: string): string {
    if (kind === "add") return "+";
    if (kind === "remove") return "−";
    return " ";
  }

  function background(kind: string): string | undefined {
    if (kind === "add") return colors.add;
    if (kind === "remove") return colors.remove;
    return undefined;
  }

  function markColor(kind: string): string {
    if (kind === "add") return p.success;
    if (kind === "remove") return p.danger;
    return colors.gutter;
  }
</script>

<View
  style={{ background: p.surface, radius: 6, overflow: "hidden" }}
>
  <View style={{ direction: "row", gap: p.space.m, paddingX: p.space.l, paddingY: p.space.s, align: "baseline" }}>
    <Text style={{ fontWeight: "bold", flex: 1, minWidth: 0, truncate: true }}>{diff.path ?? "diff"}</Text>
    <Text style={{ color: p.success }}>+{stats.added}</Text>
    <Text style={{ color: p.danger }}>−{stats.removed}</Text>
  </View>
  {#each clipped.shown as line}
    {#if line.kind === "hunk"}
      <View style={{ paddingX: p.space.l, paddingY: 2 }}>
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted }}>{line.text}</Text>
      </View>
    {:else}
      <View style={{ direction: "row", paddingX: p.space.s, background: background(line.kind) }}>
        <Text style={{ width: numberWidth, textAlign: "right", paddingRight: 6, color: colors.gutter, fontFamily: "mono", fontSize: p.text.code, lineHeight }}>{line.old ?? ""}</Text>
        <Text style={{ width: numberWidth, textAlign: "right", paddingRight: 6, color: colors.gutter, fontFamily: "mono", fontSize: p.text.code, lineHeight }}>{line.new ?? ""}</Text>
        <Text style={{ width: 18, textAlign: "center", color: markColor(line.kind), fontFamily: "mono", fontSize: p.text.code, lineHeight }}>{mark(line.kind)}</Text>
        <Text pre style={{ flex: 1, minWidth: 0, fontFamily: "mono", fontSize: p.text.code, lineHeight }}>{line.text}</Text>
      </View>
    {/if}
  {/each}
  {#if clipped.hidden > 0}
    <View style={{ paddingX: p.space.l, paddingY: p.space.s }}>
      <Text style={{ color: p.muted }}>… {clipped.hidden} more lines (Toggle full tool results shows all)</Text>
    </View>
  {/if}
</View>
