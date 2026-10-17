<!-- How the focused pane's file is indented, as a status bar entry. Pressing it offers the other styles. -->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { indentLabel, type EditorService } from "./service";

  let { service, change }: { service: EditorService; change: () => void } = $props();

  const label = $derived.by(() => {
    const buffer = service.active();
    if (!buffer || !buffer.indent) {
      return "";
    }
    return indentLabel(buffer.indent);
  });
</script>

{#if label !== ""}
  <View onpress={change}>
    <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{label}</Text>
  </View>
{/if}
