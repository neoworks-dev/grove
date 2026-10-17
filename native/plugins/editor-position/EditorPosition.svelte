<!-- Where the editor's newest cursor is, as a status bar entry. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { editorState } from "../editor/editorState.svelte";
</script>

<Text style={{ color: "#a1a1aa", fontSize: 12 }}>{editorState.describePosition()}</Text>
