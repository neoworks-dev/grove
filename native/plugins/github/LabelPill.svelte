<!-- A label as GitHub colours it: its colour for the text, a faint wash of it behind. -->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize } from "../theme/tokens";
  import { labelColors } from "./present";

  interface Props {
    name: string;
    color: string;
  }

  let { name, color }: Props = $props();

  const look = $derived(labelColors(color, colors.muted));
</script>

<View style={{ shrink: 0, height: 18, paddingX: 7, align: "center", justify: "center", radius: 9, background: look.background }}>
  <Text style={{ fontSize: fontSize.xxs, color: look.text }}>{name}</Text>
</View>
