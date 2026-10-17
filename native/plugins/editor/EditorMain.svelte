<!--
  The code editor, drawn by GPUI, filling the `main` slot. It reports what the file is, whether
  it has unsaved changes and where the cursors are into `editorState`, which the status bar
  entries and the editor's commands read.
-->
<script lang="ts">
  import { element, invoke } from "@neoworks/svelte-gpui";
  import { editorState, type EditorMethods } from "./editorState.svelte";

  /** The editor `src/editor/mod.rs` registers, with the events it emits. */
  const Editor = element<
    {
      path: string;
      onopened: (event: { path: string; lines: number }) => void;
      onerror: (event: { path: string; message: string }) => void;
      onselections: (event: { count: number; row: number; column: number; selected: boolean }) => void;
      ondirty: (event: { modified: boolean }) => void;
      onsaved: (event: { path: string }) => void;
    },
    EditorMethods
  >("editor");

  let editor = $state<EditorMethods | null>(null);

  // The layout remounts this component when a split wraps or frees its pane, so the host is
  // asked for the file once, and the editor is not drawn before it is known.
  if (editorState.path === "") {
    invoke<string>("initial_file").then((file) => {
      editorState.path = file;
    });
  }

  // The element is known to the commands only while it is mounted.
  $effect(() => {
    editorState.element = editor;
    return () => {
      editorState.element = null;
    };
  });
</script>

{#if editorState.path !== ""}
<Editor
  bind:this={editor}
  style={{ flex: 1 }}
  key="main"
  path={editorState.path}
  onopened={(event) => {
    editorState.fileSummary = event.path;
    editorState.message = "";
    editorState.modified = false;
  }}
  onerror={(event) => (editorState.message = event.message)}
  ondirty={(event) => {
    editorState.modified = event.modified;
    if (event.modified) {
      editorState.message = "";
    }
  }}
  onsaved={() => (editorState.message = "saved")}
  onselections={(event) => {
    editorState.row = event.row;
    editorState.column = event.column;
    editorState.cursorCount = event.count;
  }}
/>
{/if}
