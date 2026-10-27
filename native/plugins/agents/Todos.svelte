<!--
  The shared todo list, which the user and every agent change: a row per item with a box to check
  it off, and a cross to remove it. New items are written in the composer with /todo. Ported from
  neo term's Todos panel (apps/term widgets/todos.rs).
-->
<script lang="ts">
  import { Button, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import { palette } from "./palette";
  import { doneCount, toggleChange } from "./todos";

  let { chat }: { chat: ChatSession } = $props();

  const p = palette;

  const items = $derived(chat.todos());
  const done = $derived(doneCount(items));
</script>

{#if items.length > 0}
  <View style={{ gap: p.space.s, minHeight: 0, shrink: 1 }}>
    <View style={{ direction: "row", gap: p.space.s }}>
      <Text style={{ color: p.muted, fontWeight: "bold" }}>Todos</Text>
      <Text style={{ color: p.muted }}>· {done}/{items.length}</Text>
      <View style={{ flex: 1, minWidth: 0 }} />
      <Text style={{ color: p.muted }}>/todo adds</Text>
    </View>
    <Scroll style={{ minHeight: 0, shrink: 1 }}>
      <View style={{ gap: p.space.s }}>
        {#each items as item (item.id)}
          <View style={{ direction: "row", gap: p.space.m, align: "start" }}>
            <Button
              onpress={() => void chat.changeTodos(toggleChange(item))}
              style={{ color: item.done ? p.success : p.muted, shrink: 0 }}
              hover={{ background: p.band }}
            >
              <Text>{item.done ? "[x]" : "[ ]"}</Text>
            </Button>
            <Text style={{ flex: 1, minWidth: 0, color: item.done ? p.muted : p.fg, strikethrough: item.done }}>{item.text}</Text>
            <Button
              onpress={() => void chat.changeTodos({ action: "remove", id: item.id })}
              style={{ color: p.muted, shrink: 0 }}
              hover={{ background: p.band }}
            >
              <Text>×</Text>
            </Button>
          </View>
        {/each}
      </View>
    </Scroll>
  </View>
{/if}
