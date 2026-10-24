<!--
  A pane of the editor: this pane's tabs over the editor element, which shows the active tab's
  document. The text lives in Rust under the document's id, so drawing this component again,
  as splitting or closing a neighbouring pane does, finds the same text and cursors. Pressing in the
  editor focuses the pane.
-->
<script lang="ts">
  import { element, type ElementMethods } from "@neoworks/svelte-gpui";
  import { Text, View, type PointerEvent } from "@neoworks/svelte-gpui/ui";
  import Slot from "../../kernel/slots/Slot.svelte";
  import TabStrip, { type TabEntry } from "../panel/TabStrip.svelte";
  import { activeEditorTheme, type EditorTheme } from "../theme/editorTheme";
  import { colors, fontSize } from "../theme/tokens";
  import type { EditorService, EditorViewMethods } from "./service";

  /** How wide the minimap is, in pixels: the strip the editor paints and the view over it that takes the pointer. */
  const MINIMAP_WIDTH = 90;

  interface Props {
    service: EditorService;
    /** The pane this is drawn in; one editor outside the split layout is the pane "main". */
    leafId?: string;
  }

  let { service, leafId = "main" }: Props = $props();

  /** The editor `src/editor/mod.rs` registers. */
  const Editor = element<
    { document: number; pane: string; viewId: string; hideSources: string[]; minimap: number; sequencePending: boolean; theme: EditorTheme; keymap: string; onfocus: () => void; ongoto: (event: GotoEvent) => void },
    EditorViewMethods
  >("editor");

  /** Where the editor asks to go when a definition is in another file. */
  interface GotoEvent {
    path: string;
    line: number;
    character: number;
  }

  let view = $state<ElementMethods<EditorViewMethods> | null>(null);
  let draggingMinimap = $state(false);

  const tabs = $derived(service.tabsIn(leafId));
  const active = $derived(service.activeIn(leafId));
  const entries = $derived<TabEntry[]>(tabs.map((tab) => ({ id: String(tab.id), title: tab.title, dirty: tab.dirty })));

  // Commands reach the editor through the service while it is mounted.
  $effect(() => {
    if (!view) {
      return;
    }
    return service.registerView(leafId, view);
  });

  // The pane that has the focus has the keyboard in its editor, so a split's new pane takes the
  // keys from the one it came from, and a prompt that closes gives them back.
  $effect(() => {
    if (view && service.isFocusedPane(leafId) && service.prompt() === null) {
      view.focus();
    }
  });

  // A go-to-definition into another file opens it, and the cursor moves once this pane shows it.
  $effect(() => {
    const request = service.pendingReveal();
    if (!view || !request || active?.id !== request.documentId || !service.isFocusedPane(leafId)) {
      return;
    }
    service.finishReveal(request);
    void view.goto(request.line, request.character);
  });

  /** A right press in the editor: the cursor goes there and the context menu opens. */
  function pressEditor(event: { windowX: number; windowY: number }): void {
    void service.openContextMenu(leafId, event.windowX, event.windowY);
  }

  /** A press on the minimap scrolls the editor there, and holds the pointer so dragging keeps scrolling. */
  function pressMinimap(event: PointerEvent): void {
    draggingMinimap = true;
    void view?.minimapScroll(event.windowY);
  }

  /** The pointer moves over the minimap while the button is down. */
  function dragMinimap(event: PointerEvent): void {
    if (!draggingMinimap) {
      return;
    }
    void view?.minimapScroll(event.windowY);
  }

  /** The button is released, wherever the pointer is. */
  function releaseMinimap(): void {
    draggingMinimap = false;
  }

  /** Shows the tab with this id in this pane. */
  function selectTab(tabId: string): void {
    service.select(leafId, Number(tabId));
  }

  /** Closes the tab with this id in this pane, asking about unsaved changes first. */
  function closeTab(tabId: string): void {
    void service.closeTab(leafId, Number(tabId));
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if entries.length > 0}
    <TabStrip tabs={entries} activeId={active ? String(active.id) : ""} onselect={selectTab} onclose={closeTab} />
  {/if}
  {#if active}
    <Slot name="editor.breadcrumbs" props={{ leafId, documentId: active.id, goto: (line: number, character: number) => void view?.goto(line, character) }} />
    <View style={{ flex: 1, minHeight: 0 }} buttons={["right"]} ondown={pressEditor}>
      <Editor
        bind:this={view}
        style={{ flex: 1 }}
        key={`editor-${leafId}`}
        document={active.id}
        pane={leafId}
        viewId={leafId}
        hideSources={service.hiddenSourcesIn(leafId, active.id)}
        minimap={MINIMAP_WIDTH}
        sequencePending={service.sequencePending()}
        theme={activeEditorTheme()}
        keymap={service.keymap()}
        onfocus={() => service.focusPane(leafId)}
        ongoto={(event) => void service.reveal(event.path, event.line, event.character)}
      />
      <View
        buttons={["left"]}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: MINIMAP_WIDTH, cursor: "pointer" }}
        ondown={pressMinimap}
        onmove={dragMinimap}
        onup={releaseMinimap}
      />
    </View>
  {:else}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 4 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>No file open</Text>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Open one with Ctrl+O.</Text>
    </View>
  {/if}
</View>
