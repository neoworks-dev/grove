<!-- The focused pane's file and its unsaved-changes marker, as a status bar entry. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { EditorService } from "./service";

  let { service }: { service: EditorService } = $props();

  const buffer = $derived(service.active());
  const message = $derived(service.message());

  /** The file's path with a dot after it while there are unsaved changes, and any message after that. */
  const description = $derived.by(() => {
    let text = "";
    if (buffer) {
      text = buffer.path;
      if (buffer.dirty) {
        text += " ●";
      }
    }
    if (message && text !== "") {
      return `${text} · ${message}`;
    }
    return text + message;
  });

  const color = $derived.by(() => {
    if (buffer && buffer.dirty) {
      return "#f97316";
    }
    return "#a1a1aa";
  });
</script>

<Text style={{ color, fontSize: 12 }}>{description}</Text>
