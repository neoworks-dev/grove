<!--
  The native app, for now only the editor: a status line above it says which file is
  open and whether it has unsaved changes, where the newest cursor is and how many there are.
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
    ondirty: (event: { modified: boolean }) => void;
    onsaved: (event: { path: string }) => void;
  }>("editor");

  let path = $state("");
  let fileSummary = $state("");
  let message = $state("");
  let modified = $state(false);
  let position = $state("");

  /** Line and column of the newest cursor, counted from one, and how many cursors there are. */
  function describeSelections(event: { count: number; row: number; column: number }): string {
    const place = `Ln ${event.row + 1}, Col ${event.column + 1}`;
    if (event.count === 1) {
      return place;
    }
    return `${place} · ${event.count} cursors`;
  }

  /** The file name with a dot after it while there are unsaved changes, and any message after that. */
  function describeFile(): string {
    const marker = modified ? " ●" : "";
    if (message) {
      return `${fileSummary}${marker} · ${message}`;
    }
    return `${fileSummary}${marker}`;
  }

  invoke<string>("initial_file").then((file) => {
    path = file;
  });
</script>

<View style={{ flex: 1, background: "#18181b" }}>
  <View style={{ direction: "row", justify: "between", paddingX: 16, paddingY: 8, background: "#111113" }}>
    <Text style={{ color: modified ? "#f97316" : "#a1a1aa", fontSize: 12 }}>{describeFile()}</Text>
    <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{position}</Text>
  </View>
  <Editor
    style={{ flex: 1 }}
    key="main"
    {path}
    onopened={(event) => {
      fileSummary = event.path;
      message = "";
      modified = false;
    }}
    onerror={(event) => (message = event.message)}
    ondirty={(event) => {
      modified = event.modified;
      if (modified) {
        message = "";
      }
    }}
    onsaved={() => (message = "saved")}
    onselections={(event) => (position = describeSelections(event))}
  />
</View>
