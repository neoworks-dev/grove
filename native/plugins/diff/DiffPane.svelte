<!--
  A diff pane: a header with the file, what it is compared with, where the cursor is among the
  changes and the buttons that act on them, over one editor (inline) or two side by side (split).
  The editors are the same element as the editor pane's, so selection, search and the keys work
  the same. The old side is read-only, and so is the new side unless it is the file itself.
-->
<script lang="ts">
  import { element, type ElementMethods } from "@neoworks/svelte-gpui";
  import { Button, Icon, Text, Tooltip, View } from "@neoworks/svelte-gpui/ui";
  import arrowCounterClockwise from "@phosphor-icons/core/regular/arrow-counter-clockwise.svg";
  import arrowDown from "@phosphor-icons/core/regular/arrow-down.svg";
  import arrowUp from "@phosphor-icons/core/regular/arrow-up.svg";
  import columns from "@phosphor-icons/core/regular/columns.svg";
  import minus from "@phosphor-icons/core/regular/minus.svg";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import rows from "@phosphor-icons/core/regular/rows.svg";
  import type { EditorService, EditorViewMethods } from "../editor/service";
  import type { LayoutService } from "../layout/service";
  import { activeEditorTheme, type EditorTheme } from "../theme/editorTheme";
  import { colors, fontSize, iconButton, iconButtonHover, radius } from "../theme/tokens";
  import { hunkPosition } from "./model";
  import type { DiffService } from "./service";

  interface Props {
    diff: DiffService;
    editor: EditorService;
    layout: LayoutService;
    /** The pane this is drawn in. */
    leafId?: string;
  }

  let { diff, editor, layout, leafId = "main" }: Props = $props();

  /** The editor `src/editor/mod.rs` registers. */
  const Editor = element<
    { document: number; theme: EditorTheme; keymap: string; readonly: boolean; scrollGroup: string; onfocus: () => void },
    EditorViewMethods
  >("editor");

  const view = $derived(diff.view(leafId));
  const cursorRow = $derived.by(() => {
    if (view === undefined || view.rightId === null) {
      return 0;
    }
    const cursor = editor.cursorOf(view.rightId);
    if (cursor === null) {
      return 0;
    }
    return cursor.row;
  });
  const position = $derived(view === undefined ? "" : hunkPosition(view.hunks, cursorRow));
  const split = $derived(view !== undefined && view.mode === "split" && view.leftId !== null);

  let leftEditor = $state<ElementMethods<EditorViewMethods> | null>(null);
  let rightEditor = $state<ElementMethods<EditorViewMethods> | null>(null);

  // A pane made by a split asks for the diff its state names.
  $effect(() => {
    diff.ensureLoaded(leafId);
  });

  // The service draws the editors again when the decorations change, and the Edit menu reaches the new side's.
  $effect(() => {
    const editors: { left?: EditorViewMethods; right?: EditorViewMethods } = {};
    if (leftEditor !== null) {
      editors.left = leftEditor;
    }
    if (rightEditor !== null) {
      editors.right = rightEditor;
    }
    const stopDiff = diff.registerEditors(leafId, editors);
    if (rightEditor === null) {
      return stopDiff;
    }
    const stopEditor = editor.registerView(leafId, rightEditor);
    return () => {
      stopDiff();
      stopEditor();
    };
  });

  // The pane that has the focus has the keyboard in its new side.
  $effect(() => {
    if (rightEditor !== null && layout.focusedLeafId === leafId && editor.prompt() === null) {
      rightEditor.focus();
    }
  });

  /** The look of a toolbar button, raised while its mode is the one shown. */
  function toolbarStyle(active: boolean) {
    return { ...iconButton, size: 24, background: active ? colors.raised : "transparent", color: active ? colors.text : colors.dim };
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if view === undefined || view.status === "loading"}
    <View style={{ flex: 1, align: "center", justify: "center" }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Reading the changes…</Text>
    </View>
  {:else if view.status === "error"}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 4, padding: 24 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.text }}>Can't show this diff</Text>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{view.message}</Text>
    </View>
  {:else}
    <View style={{ direction: "row", align: "center", gap: 6, height: 30, shrink: 0, paddingX: 10 }}>
      <Text style={{ shrink: 0, paddingX: 6, radius: radius.sm, background: colors.raised, fontSize: fontSize.xxs, color: colors.muted }}>
        {view.baseLabel}
      </Text>
      {#if !view.editable}
        <Text style={{ shrink: 0, fontSize: fontSize.xxs, color: colors.dim }}>read only</Text>
      {/if}
      <View style={{ flex: 1 }} />
      <Text style={{ shrink: 0, fontSize: fontSize.xxs, color: colors.dim }}>{position}</Text>
      <Tooltip text="Previous change (Alt+Up)" side="bottom" align="center">
        <Button style={toolbarStyle(false)} hover={iconButtonHover} onpress={() => void diff.stepChange(-1)}>
          <Icon svg={arrowUp} size={14} />
        </Button>
      </Tooltip>
      <Tooltip text="Next change (Alt+Down)" side="bottom" align="center">
        <Button style={toolbarStyle(false)} hover={iconButtonHover} onpress={() => void diff.stepChange(1)}>
          <Icon svg={arrowDown} size={14} />
        </Button>
      </Tooltip>
      {#if view.canStage}
        <Button
          style={{ height: 24, paddingX: 6, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs }}
          hover={{ background: colors.hover, color: colors.text }}
          onpress={() => void diff.stageHunk()}
        >
          <Icon svg={plus} size={12} />
          <Text>Stage</Text>
        </Button>
      {/if}
      {#if view.canUnstage}
        <Button
          style={{ height: 24, paddingX: 6, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs }}
          hover={{ background: colors.hover, color: colors.text }}
          onpress={() => void diff.unstageHunk()}
        >
          <Icon svg={minus} size={12} />
          <Text>Unstage</Text>
        </Button>
      {/if}
      {#if view.canRevert}
        <Button
          style={{ height: 24, paddingX: 6, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs }}
          hover={{ background: colors.redSoft, color: colors.red }}
          onpress={() => void diff.revertHunk()}
        >
          <Icon svg={arrowCounterClockwise} size={12} />
          <Text>Revert</Text>
        </Button>
      {/if}
      <Tooltip text="Inline" side="bottom" align="center">
        <Button style={toolbarStyle(view.mode === "inline")} hover={iconButtonHover} onpress={() => void diff.setMode(leafId, "inline")}>
          <Icon svg={rows} size={14} />
        </Button>
      </Tooltip>
      <Tooltip text="Side by side" side="bottom" align="center">
        <Button style={toolbarStyle(view.mode === "split")} hover={iconButtonHover} onpress={() => void diff.setMode(leafId, "split")}>
          <Icon svg={columns} size={14} />
        </Button>
      </Tooltip>
    </View>
    <View style={{ flex: 1, minHeight: 0, direction: "row" }}>
      {#if split && view.leftId !== null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Editor
            bind:this={leftEditor}
            style={{ flex: 1 }}
            key={`diff-left-${leafId}`}
            document={view.leftId}
            theme={activeEditorTheme()}
            keymap={editor.keymap()}
            readonly={true}
            scrollGroup={`diff-${leafId}`}
            onfocus={() => editor.focusPane(leafId)}
          />
        </View>
        <View style={{ width: 1, background: colors.line }} />
      {/if}
      <View style={{ flex: 1, minWidth: 0 }}>
        {#if view.rightId !== null}
          <Editor
            bind:this={rightEditor}
            style={{ flex: 1 }}
            key={`diff-right-${leafId}`}
            document={view.rightId}
            theme={activeEditorTheme()}
            keymap={editor.keymap()}
            readonly={!view.editable}
            scrollGroup={split ? `diff-${leafId}` : ""}
            onfocus={() => editor.focusPane(leafId)}
          />
        {/if}
      </View>
    </View>
  {/if}
</View>
