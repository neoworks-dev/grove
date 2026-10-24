<!--
  The quiet line under the composer: how full the context is and what the session has cost.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import { usageLine } from "./composerControls";
  import { palette } from "./palette";

  interface Props {
    session: ChatSession;
    /** A short message from the composer, such as "copied". */
    notice?: string;
  }

  let { session, notice }: Props = $props();

  const p = palette;
  const usage = $derived(usageLine(session.status()));
</script>

<View style={{ direction: "row", align: "center", gap: p.space.s, paddingX: p.space.s }}>
  <Text style={{ color: p.muted, fontSize: p.text.code, shrink: 0, nowrap: true }}>{usage}</Text>
  <View style={{ flex: 1, minWidth: 0 }} />
  {#if notice !== undefined}
    <Text style={{ color: p.accent, fontSize: p.text.code }}>{notice}</Text>
  {/if}
</View>
