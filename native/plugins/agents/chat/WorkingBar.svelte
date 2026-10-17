<script lang="ts">
  // The one place the pane says a turn is in flight: a spinner, a line that rotates while you
  // wait, and the tokens the context holds. It is the chat's last row, and it only exists while
  // the agent works, so it picks a fresh line each time it appears.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { palette } from "../palette";
  import Spinner from "./Spinner.svelte";
  import { nextWorkingPhrase } from "./workingPhrases";

  let { tokens }: { tokens?: string } = $props();

  /** Long enough to read twice and not notice the swap. */
  const PHRASE_INTERVAL_MS = 4000;

  const p = palette;

  let phrase = $state(nextWorkingPhrase(""));

  $effect(() => {
    const timer = setInterval(() => {
      phrase = nextWorkingPhrase(phrase);
    }, PHRASE_INTERVAL_MS);
    return () => clearInterval(timer);
  });
</script>

<View style={{ direction: "row", align: "center", gap: p.space.m, paddingX: p.space.l, paddingY: p.space.m }}>
  <View style={{ color: p.success, width: 10, shrink: 0 }}><Spinner /></View>
  <Text style={{ flex: 1, minWidth: 0, truncate: true, color: p.muted, fontFamily: "mono", fontSize: p.text.code }}>{phrase}…</Text>
  {#if tokens !== undefined}
    <Text style={{ shrink: 0, color: p.muted, fontFamily: "mono", fontSize: p.text.code }}>{tokens} tok</Text>
  {/if}
</View>
