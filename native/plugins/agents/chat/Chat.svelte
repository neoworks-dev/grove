<script lang="ts">
  // The session's chat: every item the daemon resolved, each drawn by the renderer for its kind,
  // following the end as the agent writes. Thoughts only show once they are switched on.
  import { untrack } from "svelte";
  import { window } from "@neoworks/svelte-gpui";
  import { Image, List, Text, View } from "@neoworks/svelte-gpui/ui";
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

  let { session, emptyText = "What to do first? Ask about this codebase, or start writing code." }: Props = $props();

  const p = palette;

  // The pane shows one session for its whole life: another session gets a new Chat.
  provideChat(untrack(() => session));

  // What a neoui doc is laid out in: the chat's own width, which is not the window's once the pane
  // shares it. Until the pane has been laid out, the window's width stands in.
  let paneWidth = $state<number>();
  provideColumn({
    get width() {
      if (paneWidth === undefined) {
        return window.size.width;
      }
      return paneWidth;
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

  // The list is built anew when the window's width changes: a List that is resized keeps stale row
  // heights, so rows overlap (svelte-gpui #31). Until that is fixed, a resize returns the chat to its end.
  const width = $derived(window.size.width);
</script>

{#if items.length === 0}
  <View style={{ flex: 1, align: "center", justify: "center", gap: p.space.l, padding: p.space.l }}>
    <Image src="assets/marmot/coder.webp" fit="contain" style={{ width: 160, height: 128 }} />
    <Text style={{ color: p.muted, textAlign: "center", maxWidth: 260 }}>{emptyText}</Text>
  </View>
{:else}
  <View style={{ flex: 1, minHeight: 0 }} onresize={measured}>
    {#key width}
      <List items={rows} key={(entry: ChatRow) => entry.key} stickToEnd style={{ flex: 1, minHeight: 0 }}>
        {#snippet row(entry: ChatRow)}
          <!--
            The list hands a row anew whenever it measures one, though the row is the same. Read
            through a derived, which only passes on a different row, the row's parts are not drawn
            again: a long reply would otherwise lay out its markdown again on every resize.
          -->
          {@const chatRow = entry}
          {#if chatRow.kind === "item"}
            <ChatItem item={chatRow.item} />
          {:else if chatRow.kind === "turn"}
            <FoldRow foldKey={chatRow.foldKey} open={chatRow.open} tallies={chatRow.tallies} messages={chatRow.messages} steps={chatRow.steps} />
          {:else if chatRow.kind === "run"}
            <FoldRow foldKey={chatRow.foldKey} open={chatRow.open} tallies={chatRow.tallies} />
            {#if chatRow.open}
              {#each chatRow.items as item (item.ref)}
                <ChatItem {item} />
              {/each}
            {/if}
          {:else if chatRow.kind === "files"}
            <ChangedFiles files={chatRow.files} />
          {:else}
            <WorkingBar {tokens} />
          {/if}
        {/snippet}
      </List>
    {/key}
  </View>
{/if}
