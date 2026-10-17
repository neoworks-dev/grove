<!-- The open file and its unsaved-changes marker, as a status bar entry. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { editorState } from "./editorState.svelte";
</script>

<Text style={{ color: editorState.modified ? "#f97316" : "#a1a1aa", fontSize: 12 }}>{editorState.describeFile()}</Text>
