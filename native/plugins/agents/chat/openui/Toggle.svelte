<script lang="ts">
  // The track and knob of a switch.
  import { View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";

  let { on, focused = false }: { on: boolean; focused?: boolean } = $props();
  const p = neouiPalette;
</script>

<View
  style={{
    width: 34,
    height: 20,
    shrink: 0,
    radius: 10,
    padding: 2,
    background: on ? p.accent : p.raised,
    borderWidth: 1,
    borderColor: focused ? p.accent : on ? p.accent : p.border,
    transition: 120,
  }}
>
  <View style={{ size: 14, radius: 7, background: on ? p.bg : p.muted, translate: [on ? 14 : 0, 0] }} />
</View>
