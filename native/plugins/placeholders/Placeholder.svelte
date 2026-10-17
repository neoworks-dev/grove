<!-- Stand-in content for a sidebar view or a panel tab whose real plugin does not exist yet. -->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize } from "../theme/tokens";

  let { title, note }: { title: string; note: string } = $props();
</script>

<View style={{ padding: 12, gap: 4 }}>
  <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>{title}</Text>
  <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{note}</Text>
</View>
