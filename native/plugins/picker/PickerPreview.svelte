<!--
  The picker's preview: the selected file in a read-only editor, scrolled to the target line and
  with the match highlighted. The file is read into a document of its own (see `preview.ts`), a
  moment after the selection settles, so moving quickly down the list reads only the rows it rests on.
-->
<script lang="ts">
  import { element, files, type ElementMethods } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { EditorService, EditorViewMethods } from "../editor/service";
  import { activeEditorTheme, type EditorTheme } from "../theme/editorTheme";
  import { colors, fontSize } from "../theme/tokens";
  import { PreviewLoader, type PreviewHost, type PreviewState } from "./preview";
  import type { PreviewTarget } from "./service";

  /** How long the selection must rest before its file is read. */
  const PREVIEW_DELAY_MS = 60;

  /** The decoration sources the preview leaves out: it shows the text, not the file's git or language server marks. */
  const HIDDEN_SOURCES = ["git.changes", "lsp.diagnostics", "git.blame"];

  interface Props {
    editor: EditorService;
    target: PreviewTarget | null;
  }

  let { editor, target }: Props = $props();

  /** The editor `src/editor/mod.rs` registers. */
  const Editor = element<
    { document: number; theme: EditorTheme; keymap: string; readonly: boolean; hideSources: string[] },
    EditorViewMethods
  >("editor");

  let shown = $state<PreviewState>({ kind: "empty" });
  let view = $state<ElementMethods<EditorViewMethods> | null>(null);

  const loader = new PreviewLoader(previewHost(), (next) => {
    shown = next;
  });

  /** Lets the preview read files and make documents through the editor and the host's files. */
  function previewHost(): PreviewHost {
    return {
      sizeOf: async (path) => (await files.stat(path)).size,
      readText: (path) => files.readText(path),
      openText: (name, text) => editor.openText(name, text),
      release: (documentId) => editor.releaseDocument(documentId),
      decorate: (documentId, source, decorations) => editor.setDecorationsOf(documentId, source, decorations),
    };
  }

  // The file is read once the selection has rested on the target for a moment.
  $effect(() => {
    const wanted = target;
    const timer = setTimeout(() => void loader.show(wanted), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  });

  // Closing the picker drops the document the preview made.
  $effect(() => () => void loader.dispose());

  // The view shows the new document from the top; this puts the cursor, and so the scroll, on the target.
  $effect(() => {
    if (view !== null && shown.kind === "document") {
      void view.goto(shown.line, shown.column);
    }
  });
</script>

<View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
  {#if shown.kind === "document"}
    <Editor
      bind:this={view}
      style={{ flex: 1 }}
      key="picker-preview"
      document={shown.documentId}
      readonly={true}
      keymap="standard"
      theme={activeEditorTheme()}
      hideSources={HIDDEN_SOURCES}
    />
  {:else if shown.kind === "notice"}
    <View style={{ flex: 1, align: "center", justify: "center" }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{shown.message}</Text>
    </View>
  {/if}
</View>
