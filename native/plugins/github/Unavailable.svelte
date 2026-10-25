<!--
  What a GitHub pane says when it cannot read GitHub at all: the GitHub CLI is not installed, no one
  is logged in to it, or the folder has no GitHub remote. It says what to do and offers to try
  again once that is done.
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { Failure } from "./service";

  interface Props {
    failure: Failure;
    onretry: () => void;
  }

  let { failure, onretry }: Props = $props();

  const command = $derived.by(() => {
    if (failure.kind === "unauthenticated" || failure.kind === "missing") {
      return "gh auth login";
    }
    return "";
  });
</script>

<View style={{ flex: 1, align: "center", justify: "center", gap: 10, padding: 24 }}>
  <Text style={{ fontSize: fontSize.sm, color: colors.text, textAlign: "center" }}>{failure.message}</Text>
  {#if command !== ""}
    <Text style={{ fontFamily: "mono", fontSize: fontSize.xs, color: colors.muted, paddingX: 10, paddingY: 4, radius: radius.sm, background: colors.input }}>{command}</Text>
  {/if}
  <Button
    style={{ paddingX: 12, height: 26, align: "center", radius: radius.sm, background: colors.hover, color: colors.text, fontSize: fontSize.xs }}
    hover={{ background: colors.raised }}
    onpress={onretry}
  >
    <Text>Try again</Text>
  </Button>
</View>
