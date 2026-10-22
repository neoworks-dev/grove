<script lang="ts">
  // The session's chat: every item the daemon resolved, each drawn by the renderer for its kind,
  // following the end as the agent writes. Thoughts only show once they are switched on.
  import { untrack } from "svelte";
  import { window } from "@neoworks/svelte-gpui";
  import { List, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Layout } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "../chatSession";
  import { palette } from "../palette";
  import ChangedFiles from "./ChangedFiles.svelte";
  import ChatItem from "./ChatItem.svelte";
  import { provideChat, provideColumn } from "./context";
  import FoldRow from "./FoldRow.svelte";
  import { chatRows, type ChatRow } from "./turns";
  import { chatView } from "./viewState";
  import WorkingBar from "./WorkingBar.svelte";
  import { tokensLabel } from "./workingPhrases";

  interface Props {
    session: ChatSession;
    /** What an empty chat says. */
    emptyText?: string;
  }

  let { session, emptyText = "Nothing said yet. Write a message below." }: Props = $props();

  const p = palette;

  // The pane shows one session for its whole life: another session gets a new Chat.
  provideChat(untrack(() => session));

  // The chat's own width, which is not the window's once the pane shares it: what a neoui doc is
  // laid out in, and what the list is built for. Until the pane has been laid out, the window's
  // width stands in.
  let paneWidth = $state<number>();
  const width = $derived.by(() => {
    if (paneWidth === undefined) {
      return window.size.width;
    }
    return paneWidth;
  });
  provideColumn({
    get width() {
      return width;
    },
  });

  /** The pane was laid out or resized. */
  function measured(box: Layout): void {
    paneWidth = box.width;
  }

  const items = $derived(chatView.visibleItems(session.items()));
  const rows = $derived(
    chatRows(items, {
      fold: session.agent === undefined,
      callOf: (ref) => session.callOf(ref),
      running: session.running(),
      isOpen: (key) => chatView.isOpened(key),
    }),
  );
  const tokens = $derived(tokensLabel(session.status().usage?.contextUsed));

  let list: { scrollToIndex(index: number, options: { align: "end" }): void } | undefined = $state();

  // The list is built anew when the pane's width changes: a List that is resized keeps stale row
  // heights, so rows overlap (svelte-gpui #31). Until that is fixed, a resize returns the chat to its end.

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
    <Text style={{ color: p.muted }}>{emptyText}</Text>
  </View>
{:else}
  <View style={{ flex: 1, minHeight: 0 }} onresize={measured}>
    {#key width}
      <List bind:this={list} items={rows} key={(entry: ChatRow) => entry.key} stickToEnd style={{ flex: 1, minHeight: 0 }}>
        {#snippet row(entry: ChatRow)}
          {#if entry.kind === "item"}
            <ChatItem item={entry.item} />
          {:else if entry.kind === "turn"}
            <FoldRow foldKey={entry.foldKey} open={entry.open} tallies={entry.tallies} messages={entry.messages} steps={entry.steps} />
          {:else if entry.kind === "run"}
            <FoldRow foldKey={entry.foldKey} open={entry.open} tallies={entry.tallies} />
            {#if entry.open}
              {#each entry.items as item (item.ref)}
                <ChatItem {item} />
              {/each}
            {/if}
          {:else if entry.kind === "files"}
            <ChangedFiles files={entry.files} />
          {:else}
            <WorkingBar {tokens} />
          {/if}
        {/snippet}
      </List>
    {/key}
  </View>
{/if}
