<!--
  The shown session's details at the foot of the sessions view: the directory it works in, its
  agent's context and tokens and cost, and the language servers and MCP servers the daemon runs,
  each with whether it is up. Ported from neo term's sessions sidebar (apps/term details.rs).
-->
<script lang="ts">
  import { files } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize } from "../theme/tokens";
  import { detailsOf, grouped, type ContextDetail } from "./details";
  import type { AgentsService } from "./service";

  let { agents }: { agents: AgentsService } = $props();

  let home = $state<string | undefined>();
  void files.paths().then((paths) => (home = paths.home));

  const chat = $derived(agents.shownChat());
  const info = $derived.by(() => {
    if (chat === undefined) {
      return undefined;
    }
    return agents.sessionInfo(chat.sessionId);
  });
  const details = $derived.by(() => {
    if (chat === undefined || info === undefined) {
      return undefined;
    }
    return detailsOf(info.cwd, home, chat.status().usage, agents.connectors());
  });

  /** The colour of the context share. */
  function toneColor(tone: ContextDetail["tone"]): string {
    if (tone === "danger") {
      return colors.red;
    }
    if (tone === "accent") {
      return colors.accent;
    }
    return colors.dim;
  }
</script>

{#if details !== undefined}
  <View style={{ shrink: 0, gap: 2, paddingX: 12, paddingY: 8, borderTopWidth: 1, borderColor: colors.line }}>
    <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>Session</Text>
    <Text style={{ fontFamily: "mono", fontSize: fontSize.xxs, color: colors.muted, truncate: true }}>{details.directory}</Text>
    {#if details.context !== undefined}
      <View style={{ direction: "row", gap: 6 }}>
        <Text style={{ fontSize: fontSize.xxs, color: toneColor(details.context.tone), shrink: 0 }}>ctx {details.context.percent}%</Text>
        <Text style={{ fontSize: fontSize.xxs, color: colors.dim, flex: 1, minWidth: 0, truncate: true }}>
          {grouped(details.context.used)} / {grouped(details.context.size)}
        </Text>
      </View>
    {/if}
    {#if details.tokens !== undefined}
      <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>{details.tokens}</Text>
    {/if}
    {#if details.cost !== undefined}
      <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>{details.cost}</Text>
    {/if}
    {#if details.servers.length > 0}
      <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true, paddingTop: 6 }}>Servers</Text>
      {#each details.servers as server (server.name)}
        <View style={{ direction: "row", gap: 6 }}>
          <Text style={{ fontSize: fontSize.xxs, color: server.up ? colors.green : colors.red, shrink: 0 }}>{server.up ? "●" : "○"}</Text>
          <Text style={{ fontSize: fontSize.xxs, color: colors.muted, flex: 1, minWidth: 0, truncate: true }}>{server.name}</Text>
        </View>
      {/each}
    {/if}
  </View>
{/if}
