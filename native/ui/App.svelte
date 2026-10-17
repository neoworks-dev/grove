<!--
  The native app, for now only the editor: a status line above it says which file is
  open and where the cursor is.
-->
<script lang="ts">
  import { element, invoke } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";

  /** The editor `src/editor/mod.rs` registers, with the events it emits. */
  const Editor = element<{
    path: string;
    onopened: (event: { path: string; lines: number }) => void;
    onerror: (event: { path: string; message: string }) => void;
  }>("editor");

  let path = $state("");
  let status = $state("");

  invoke<string>("initial_file").then((file) => {
    path = file;
  });
</script>

<View style={{ flex: 1, background: "#18181b" }}>
  <View style={{ paddingX: 16, paddingY: 8, background: "#111113" }}>
    <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{status}</Text>
  </View>
  <Editor
    style={{ flex: 1 }}
    key="main"
    {path}
    onopened={(event) => (status = `${event.path} · ${event.lines} lines`)}
    onerror={(event) => (status = `${event.path}: ${event.message}`)}
  />
</View>
