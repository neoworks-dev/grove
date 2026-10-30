<!--
  A pane of the editor: this pane's tabs over the editor element, which shows the active tab's
  document. The text lives in Rust under the document's id, so drawing this component again,
  as splitting or closing a neighbouring pane does, finds the same text and cursors. Pressing in the
  editor focuses the pane.
-->
<script lang="ts">
  import type { ElementMethods } from "@neoworks/svelte-gpui";
  import { Text, View, type PointerEvent } from "@neoworks/svelte-gpui/ui";
  import { Editor, type PlacesEvent } from "@neoworks/svelte-gpui-editor";
  import Slot from "../../kernel/slots/Slot.svelte";
  import TabStrip, { type TabEntry } from "../panel/TabStrip.svelte";
  import { activeEditorTheme, type EditorTheme } from "../theme/editorTheme";
  import { colors, fontSize } from "../theme/tokens";
  import gitDiff from "@phosphor-icons/core/regular/git-diff.svg";
  import { viewIdOf, type EditorService, type EditorViewMethods, type TabInfo } from "./service";

  /** How wide the minimap is, in pixels: the strip the editor paints and the view over it that takes the pointer. */
  const MINIMAP_WIDTH = 90;

  interface Props {
    service: EditorService;
    /** The pane this is drawn in; one editor outside the split layout is the pane "main". */
    leafId?: string;
  }

  let { service, leafId = "main" }: Props = $props();

  let view = $state<ElementMethods<EditorViewMethods> | null>(null);
  let places = $state<PlacesEvent>({ textLeft: 0, lineHeight: 21, rows: [], blocks: [] });
  let draggingMinimap = $state(false);

  const tabs = $derived(service.tabsIn(leafId));
  const active = $derived(service.activeTabIn(leafId));
  const entries = $derived<TabEntry[]>(tabs.map(entryOf));
  /** The document drawn left of the active one, as a diff side by side has; null otherwise. */
  const companion = $derived.by(() => {
    if (!active) {
      return null;
    }
    return service.companionOf(leafId, active.id, active.kind);
  });
  /** How wide the minimap is: side by side has none, so nothing over its place takes the pointer. */
  const minimapWidth = $derived.by(() => {
    if (companion === null) {
      return MINIMAP_WIDTH;
    }
    return 0;
  });

  /** A tab as the tab strip draws it: a diff tab has the diff icon in front of its file's name. */
  function entryOf(tab: TabInfo): TabEntry {
    if (tab.kind === "diff") {
      return { id: tab.key, title: tab.title, icon: gitDiff, dirty: tab.dirty };
    }
    return { id: tab.key, title: tab.title, dirty: tab.dirty };
  }

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

  /** The editor reports where its lines and keyed blocks are, so plugins can lay widgets over them. */
  function placeRows(event: PlacesEvent): void {
    places = event;
  }

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

  /** Shows the tab with this key in this pane. */
  function selectTab(key: string): void {
    service.selectKey(leafId, key);
  }

  /** Closes the tab with this key in this pane, asking about unsaved changes first. */
  function closeTab(key: string): void {
    void service.closeKey(leafId, key);
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if entries.length > 0}
    <TabStrip tabs={entries} activeId={active ? active.key : ""} onselect={selectTab} onclose={closeTab} />
  {/if}
  {#if active}
    <Slot name="editor.breadcrumbs" props={{ leafId, documentId: active.id, tabKind: active.kind, goto: (line: number, character: number) => void view?.goto(line, character) }} />
    <View style={{ flex: 1, minHeight: 0 }} buttons={["right"]} ondown={pressEditor}>
      <Editor
        bind:this={view}
        style={{ flex: 1 }}
        key={`editor-${leafId}`}
        document={active.id}
        pane={leafId}
        viewId={viewIdOf(leafId, active.kind)}
        hideSources={service.hiddenSourcesIn(leafId, active.id, active.kind)}
        companion={companion}
        sideLabels={service.sideLabelsOf(leafId, active.id, active.kind)}
        minimap={MINIMAP_WIDTH}
        sequencePending={service.sequencePending()}
        leaderKey={service.leaderKeyBound()}
        theme={activeEditorTheme()}
        keymap={service.keymap()}
        onfocus={() => service.focusPane(leafId)}
        ongoto={(event) => void service.reveal(event.path, event.line, event.character)}
        onplaces={placeRows}
      />
      <Slot name="editor.overlay" props={{ leafId, documentId: active.id, tabKind: active.kind, places, rightInset: minimapWidth }} />
      {#if companion === null}
        <View
          buttons={["left"]}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: MINIMAP_WIDTH, cursor: "pointer" }}
          ondown={pressMinimap}
          onmove={dragMinimap}
          onup={releaseMinimap}
        />
      {/if}
    </View>
  {:else}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 4 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>No file open</Text>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Open one with Ctrl+O.</Text>
    </View>
  {/if}
</View>
