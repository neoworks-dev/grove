<!--
  The native app, for now only the editor: a status line above it says which file is
  open, where the newest cursor is and how many there are.
-->
<script lang="ts">
  import { element, invoke } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";

  /** The editor `src/editor/mod.rs` registers, with the events it emits. */
  const Editor = element<{
    path: string;
    onopened: (event: { path: string; lines: number }) => void;
    onerror: (event: { path: string; message: string }) => void;
    onselections: (event: { count: number; row: number; column: number; selected: boolean }) => void;
  }>("editor");

  let path = $state("");
  let status = $state("");
  let position = $state("");

  /** Line and column of the newest cursor, counted from one, and how many cursors there are. */
  function describeSelections(event: { count: number; row: number; column: number }): string {
    const place = `Ln ${event.row + 1}, Col ${event.column + 1}`;
    if (event.count === 1) {
      return place;
    }
    return `${place} · ${event.count} cursors`;
  }

  invoke<string>("initial_file").then((file) => {
    path = file;
  });
</script>

<View style={{ flex: 1, background: "#18181b" }}>
  <View style={{ direction: "row", justify: "between", paddingX: 16, paddingY: 8, background: "#111113" }}>
    <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{status}</Text>
    <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{position}</Text>
  </View>
  <Editor
    style={{ flex: 1 }}
    key="main"
    {path}
    onopened={(event) => (status = `${event.path} · ${event.lines} lines`)}
    onerror={(event) => (status = `${event.path}: ${event.message}`)}
    onselections={(event) => (position = describeSelections(event))}
  />
</View>
