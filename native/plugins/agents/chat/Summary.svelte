<script lang="ts">
  // A tool result collapsed to a few lines (see lib/summary.ts for which).
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Component } from "@suite/protocol/types";
  import { summarize } from "./summary";
  import { palette } from "../palette";
  import Self from "./Component.svelte";
  import Runs from "./Runs.svelte";

  let { component, ref }: { component: Component; ref: string } = $props();
  const p = palette;
  const leaves = $derived(summarize(component));
</script>

<View style={{ gap: 2 }}>
  {#each leaves as leaf}
    {#if leaf.kind === "title"}
      <Text style={{ fontWeight: "bold", color: leaf.tone ? p[leaf.tone] : undefined, truncate: true }}>{leaf.title}</Text>
    {:else if leaf.kind === "code"}
      {#each leaf.lines as line}
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, truncate: true }}>{line}</Text>
      {/each}
    {:else if leaf.kind === "text"}
      {#each leaf.lines as line}
        <Text style={{ truncate: true, fontFamily: line.mono ? "mono" : undefined, fontSize: line.mono ? p.text.code : undefined }}>{line.prefix}<Runs spans={line.spans} /></Text>
      {/each}
    {:else if leaf.kind === "diff"}
      <View style={{ direction: "row", gap: p.space.m }}>
        <Text style={{ truncate: true, shrink: 1, minWidth: 0 }}>{leaf.path}</Text>
        <Text style={{ color: p.success }}>+{leaf.added}</Text>
        <Text style={{ color: p.danger }}>−{leaf.removed}</Text>
      </View>
    {:else if leaf.kind === "kv"}
      <Text style={{ truncate: true }}>
        {#each leaf.items as item, index}{#if index > 0}<Text style={{ color: p.muted }}>{" · "}</Text>{/if}<Text style={{ color: p.muted }}>{`${item.key}: `}</Text><Text style={{ color: item.tone ? p[item.tone] : undefined, fontWeight: item.tone ? "bold" : undefined }}>{item.value}</Text>{/each}
      </Text>
    {:else if leaf.kind === "line"}
      <Text style={{ truncate: true }}>{leaf.text}</Text>
    {:else if leaf.kind === "image" || leaf.kind === "other"}
      <Self component={leaf.component} {ref} limit={0} />
    {:else if leaf.kind === "more"}
      <Text style={{ color: p.muted }}>… +{leaf.count} lines</Text>
    {/if}
  {/each}
</View>
