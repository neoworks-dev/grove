<!-- What a new split shows until something is dropped into it. -->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize } from "../theme/tokens";
</script>

<View style={{ flex: 1, align: "center", justify: "center", gap: 4, padding: 12 }}>
  <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>Empty pane</Text>
  <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Drag a pane onto it, or close it.</Text>
</View>
