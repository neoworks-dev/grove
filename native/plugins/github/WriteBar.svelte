<!--
  The bar at the foot of an item's page that stands between a click and a write to GitHub: it says
  what is about to be sent, and sends it only on Confirm. While the write runs it says so, and when
  it failed it shows why until it is dismissed.
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { ItemKind } from "./model";
  import { commentPreview, writeConfirmLabel, writeQuestion } from "./present";
  import type { WriteState } from "./service";

  interface Props {
    write: WriteState;
    repo: string;
    number: number;
    kind: ItemKind;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let { write, repo, number, kind, onconfirm, oncancel }: Props = $props();

  const pending = $derived(write.pending);
  const question = $derived.by(() => {
    if (pending === null) {
      return "";
    }
    if (write.running) {
      return "Sending…";
    }
    return writeQuestion(pending, repo, number, kind);
  });
  const preview = $derived.by(() => {
    if (pending !== null && pending.kind === "comment") {
      return commentPreview(pending.body, 80);
    }
    return "";
  });
  const quiet = { height: 26, paddingX: 10, align: "center", radius: radius.sm, fontSize: fontSize.xs, color: colors.muted } as const;
</script>

{#if pending !== null}
  <View style={{ shrink: 0, gap: 6, padding: 10, borderTopWidth: 1, borderColor: colors.line, background: colors.raised }}>
    <Text style={{ fontSize: fontSize.sm, color: colors.text }}>{question}</Text>
    {#if preview !== ""}
      <Text style={{ truncate: true, fontSize: fontSize.xs, color: colors.muted }}>{preview}</Text>
    {/if}
    <View style={{ direction: "row", align: "center", gap: 8 }}>
      <Button
        style={{ ...quiet, background: colors.accent, color: colors.inverse, fontWeight: "bold" }}
        disabled={write.running}
        onpress={onconfirm}
      >
        <Text>{writeConfirmLabel(pending, kind)}</Text>
      </Button>
      <Button style={quiet} hover={{ background: colors.hover, color: colors.text }} disabled={write.running} onpress={oncancel}>
        <Text>Cancel</Text>
      </Button>
    </View>
  </View>
{:else if write.message !== ""}
  <View style={{ shrink: 0, direction: "row", align: "center", gap: 8, padding: 10, borderTopWidth: 1, borderColor: colors.line, background: colors.raised }}>
    <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xs, color: colors.red }}>{write.message}</Text>
    <Button style={quiet} hover={{ background: colors.hover, color: colors.text }} onpress={oncancel}>
      <Text>Dismiss</Text>
    </Button>
  </View>
{/if}
