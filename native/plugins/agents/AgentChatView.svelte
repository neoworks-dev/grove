<!--
  One agent's own chat, in place of the session's: what a subagent or guest did and said,
  read-only, drawn like the main chat. The back button returns to the session.
  Ported from neoworks-harness apps/gui (plugins/agentview).
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import Chat from "./chat/Chat.svelte";
  import { palette } from "./palette";

  interface Props {
    chat: ChatSession;
    harness: string;
    /** The model as it is shown. */
    model?: string;
    /** The agent's task; its first line is shown. */
    task: string;
    onback: () => void;
  }

  let { chat, harness, model, task, onback }: Props = $props();

  const p = palette;

  const headline = $derived(task.split("\n").find((line) => line.trim() !== "") ?? "");
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  <View
    style={{
      direction: "row",
      align: "center",
      gap: p.space.m,
      paddingX: p.space.l,
      paddingY: p.space.s,
      background: p.surface,
      borderBottomWidth: 1,
      borderColor: p.border,
    }}
  >
    <Button onpress={onback} style={{ paddingX: p.space.m, radius: 4, color: p.accent }} hover={{ background: p.band }}>
      <Text>◂ back</Text>
    </Button>
    <Text style={{ color: p.accent, fontWeight: "bold" }}>{harness}</Text>
    {#if model !== undefined}
      <Text style={{ color: p.muted }}>· {model}</Text>
    {/if}
    <Text style={{ flex: 1, minWidth: 0, truncate: true, color: p.muted }}>{headline}</Text>
  </View>
  <Chat session={chat} emptyText="Nothing from this agent yet." />
</View>
