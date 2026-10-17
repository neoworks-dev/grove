<!-- Where the focused pane's newest cursor is, as a status bar entry. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { EditorService } from "../editor/service";

  let { service }: { service: EditorService } = $props();

  /** Line and column of the newest cursor, counted from one, and how many cursors there are. */
  const description = $derived.by(() => {
    const buffer = service.active();
    if (!buffer) {
      return "";
    }
    const cursor = service.cursorOf(buffer.id);
    if (!cursor) {
      return "Ln 1, Col 1";
    }
    const place = `Ln ${cursor.row + 1}, Col ${cursor.column + 1}`;
    if (cursor.count === 1) {
      return place;
    }
    return `${place} · ${cursor.count} cursors`;
  });
</script>

<Text style={{ color: "#a1a1aa", fontSize: 12 }}>{description}</Text>
