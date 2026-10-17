<!-- What the last diff or hunk action had to say, as a status bar entry. Empty until there is something. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize } from "../theme/tokens";
  import type { DiffService } from "./service";

  let { diff }: { diff: DiffService } = $props();

  const notice = $derived(diff.notice());
</script>

{#if notice !== ""}
  <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>{notice}</Text>
{/if}
