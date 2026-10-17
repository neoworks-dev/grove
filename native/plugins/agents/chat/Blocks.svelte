<script lang="ts">
  // Parsed markdown: paragraphs, headings, lists, quotes, code and rules, drawn row by row
  // (lib/markdown.ts flattens the nesting). Inline styles are nested `Text` runs inside the
  // paragraph's `Text`.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Block } from "@suite/protocol/types";
  import { lineHeightOf } from "./components";
  import { indentCells, markdownRows, type RowGap } from "./markdown";
  import { palette } from "../palette";
  import CodeBlock from "./CodeBlock.svelte";
  import Runs from "./Runs.svelte";

  interface Props {
    blocks: readonly Block[];
    /** Font size of a paragraph; headings are sized from it. */
    size: number;
  }

  let { blocks, size }: Props = $props();
  const p = palette;

  const rows = $derived(markdownRows(blocks));
  /** Width of one character, to turn indents in characters into pixels. */
  const charWidth = $derived(size * 0.6);

  function headingSize(level: number): number {
    if (level <= 1) return Math.round(size * 1.4);
    if (level === 2) return Math.round(size * 1.2);
    return size;
  }

  function gapOf(gap: RowGap): number {
    if (gap === "loose") return p.space.m;
    return gap === "tight" ? 2 : 0;
  }
</script>

<View>
  {#each rows as row}
    <View style={{ direction: "row", marginTop: gapOf(row.gap), color: row.quote > 0 ? p.muted : undefined }}>
      {#each { length: row.quote } as _}
        <View style={{ width: 2, background: p.border, marginRight: p.space.m }} />
      {/each}
      {#each indentCells(row) as cell}
        <Text style={{ width: Math.round(cell.chars * charWidth), lineHeight: lineHeightOf(size), color: cell.marker?.done ? p.success : p.muted }}>{cell.marker?.text ?? ""}</Text>
      {/each}
      {#if row.kind === "paragraph"}
        <Text style={{ flex: 1, minWidth: 0, lineHeight: lineHeightOf(size) }}><Runs spans={row.spans} /></Text>
      {:else if row.kind === "heading"}
        <Text style={{ flex: 1, minWidth: 0, fontSize: headingSize(row.level), fontWeight: "bold", lineHeight: lineHeightOf(headingSize(row.level)) }}><Runs spans={row.spans} /></Text>
      {:else if row.kind === "code"}
        <View style={{ flex: 1, minWidth: 0 }}><CodeBlock code={row.code} /></View>
      {:else}
        <View style={{ flex: 1, height: 1, background: p.border, marginY: p.space.s, alignSelf: "center" }} />
      {/if}
    </View>
  {/each}
</View>
