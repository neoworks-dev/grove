<!--
  What a question is about, compact: details, a few lines of a diff or code, text. Ported from
  neoworks-harness apps/gui (plugins/composer); the side-by-side diff comes with #461.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Component } from "@suite/protocol/types";
  import { palette } from "./palette";
  import { plainText, previewLines } from "./prompt";

  interface Props {
    components: readonly Component[];
    /** Shows the edit's diff in the editor again. Given when the editor shows the diff, which the card then only names. */
    onshowdiff?: () => void;
  }

  let { components, onshowdiff }: Props = $props();

  const p = palette;
  const PREVIEW = 8;
</script>

<View style={{ gap: p.space.s }}>
  {#each components as component}
    {#if component.type === "kv"}
      {#each component.items as item}
        <View style={{ direction: "row", gap: p.space.m }}>
          <Text style={{ color: p.muted, shrink: 0 }}>{item.key}</Text>
          <Text style={{ color: item.tone === "danger" ? p.danger : p.accent, flex: 1, minWidth: 0 }}>{item.value}</Text>
        </View>
      {/each}
    {:else if component.type === "diff"}
      {@const changed = component.lines.filter((line) => line.kind === "add" || line.kind === "remove")}
      {@const added = changed.filter((line) => line.kind === "add").length}
      {@const shown = changed.slice(0, PREVIEW)}
      {#if onshowdiff !== undefined}
        <View onpress={onshowdiff} style={{ direction: "row", gap: p.space.m, cursor: "pointer" }}>
          <Text style={{ color: p.accent, truncate: true, shrink: 1, minWidth: 0 }}>{component.path ?? "diff"}</Text>
          <Text style={{ color: p.success, shrink: 0 }}>+{added}</Text>
          <Text style={{ color: p.danger, shrink: 0 }}>−{changed.length - added}</Text>
          <Text style={{ color: p.muted, shrink: 0 }}>shown in the editor</Text>
        </View>
      {:else}
        <Text style={{ color: p.muted, truncate: true }}>{component.path ?? "diff"} · +{added} −{changed.length - added}</Text>
        <View style={{ background: p.surface, radius: 6, padding: p.space.m }}>
          {#each shown as line}
            <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: line.kind === "add" ? p.success : p.danger, nowrap: true, truncate: true }}>
              {line.kind === "add" ? "+" : "−"} {line.text}
            </Text>
          {/each}
          {#if changed.length > shown.length}
            <Text style={{ color: p.muted }}>… {changed.length - shown.length} more changed lines</Text>
          {/if}
        </View>
      {/if}
    {:else if component.type === "code"}
      {@const preview = previewLines(component.code, PREVIEW)}
      <View style={{ background: p.surface, radius: 6, padding: p.space.m }}>
        {#each preview.lines as line}
          <Text style={{ fontFamily: "mono", fontSize: p.text.code, nowrap: true, truncate: true }}>{line === "" ? " " : line}</Text>
        {/each}
        {#if preview.more > 0}
          <Text style={{ color: p.muted }}>… {preview.more} more lines</Text>
        {/if}
      </View>
    {:else if component.type === "text"}
      {@const preview = previewLines(plainText(component.blocks), PREVIEW)}
      <View>
        {#each preview.lines as line}
          <Text style={{ color: component.tone === "muted" ? p.muted : p.fg }}>{line === "" ? " " : line}</Text>
        {/each}
        {#if preview.more > 0}
          <Text style={{ color: p.muted }}>… {preview.more} more lines</Text>
        {/if}
      </View>
    {:else if component.type === "file"}
      <Text style={{ color: p.accent }}>{component.name ?? component.path}</Text>
    {/if}
  {/each}
</View>
