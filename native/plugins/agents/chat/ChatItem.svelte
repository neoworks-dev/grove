<script lang="ts">
  // One item of the conversation, drawn by the renderer for its kind. A kind nobody draws falls
  // back to its component as it is.
  import type { ViewItem } from "@suite/protocol/types";
  import AgentItem from "./AgentItem.svelte";
  import FallbackItem from "./FallbackItem.svelte";
  import NoticeItem from "./NoticeItem.svelte";
  import { hasButtons } from "./components";
  import { useChat } from "./context";
  import ThoughtItem from "./ThoughtItem.svelte";
  import ToolItem from "./ToolItem.svelte";
  import ToolRow from "./ToolRow.svelte";
  import UserItem from "./UserItem.svelte";

  let { item }: { item: ViewItem } = $props();

  const chat = useChat();
  /** What the events say about the call, for a call that is not a question. */
  const call = $derived(hasButtons(item.component) ? undefined : chat.callOf(item.ref));
</script>

{#if item.kind === "user"}
  <UserItem {item} />
{:else if item.kind === "agent"}
  <AgentItem {item} />
{:else if item.kind === "thought"}
  <ThoughtItem {item} />
{:else if item.kind === "tool" && call !== undefined}
  <ToolRow {item} {call} />
{:else if item.kind === "tool"}
  <ToolItem {item} />
{:else if item.kind === "notice"}
  <NoticeItem {item} />
{:else}
  <FallbackItem {item} />
{/if}
