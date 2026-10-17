<script lang="ts">
  // The session's chat: every item the daemon resolved, each drawn by the renderer for its kind,
  // following the end as the agent writes. Thoughts only show once they are switched on.
  import { untrack } from "svelte";
  import { window } from "@neoworks/svelte-gpui";
  import { List, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ViewItem } from "@suite/protocol/types";
  import type { ChatSession } from "../chatSession";
  import { palette } from "../palette";
  import ChatItem from "./ChatItem.svelte";
  import { provideChat } from "./context";
  import { chatView } from "./viewState";

  let { session }: { session: ChatSession } = $props();

  const p = palette;

  // The pane shows one session for its whole life: another session gets a new Chat.
  provideChat(untrack(() => session));

  const items = $derived(chatView.visibleItems(session.items()));

  let list: { scrollToIndex(index: number, options: { align: "end" }): void } | undefined = $state();

  // The list is built anew when the window's width changes: a List that is resized keeps stale row
  // heights, so rows overlap (svelte-gpui #31). Until that is fixed, a resize returns the chat to its end.
  const width = $derived(window.size.width);

  // `stickToEnd` follows new items only once the list is at its end, which a session that has just
  // been opened (all its items at once) never is: start such a chat at its end.
  let startedAt: string | undefined;
  $effect(() => {
    const count = items.length;
    const start = `${session.sessionId}@${width}`;
    if (count === 0 || startedAt === start) {
      return;
    }
    startedAt = start;
    list?.scrollToIndex(count - 1, { align: "end" });
  });
</script>

{#if items.length === 0}
  <View style={{ flex: 1, align: "center", justify: "center", padding: p.space.l }}>
    <Text style={{ color: p.muted }}>Nothing said yet. Write a message below.</Text>
  </View>
{:else}
  {#key width}
    <List bind:this={list} {items} key={(item: ViewItem) => item.ref} stickToEnd style={{ flex: 1, minHeight: 0 }}>
      {#snippet row(item: ViewItem)}
        <ChatItem {item} />
      {/snippet}
    </List>
  {/key}
{/if}
