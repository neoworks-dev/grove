<!--
  The strip over an editor pane's diff tab: what the file is compared with, where the cursor is
  among the changes, and the buttons that move between and act on them. It draws nothing over a
  file's own tab.
-->
<script lang="ts">
  import { Button, Icon, Text, Tooltip, View } from "@neoworks/svelte-gpui/ui";
  import arrowCounterClockwise from "@phosphor-icons/core/regular/arrow-counter-clockwise.svg";
  import arrowDown from "@phosphor-icons/core/regular/arrow-down.svg";
  import arrowUp from "@phosphor-icons/core/regular/arrow-up.svg";
  import columns from "@phosphor-icons/core/regular/columns.svg";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import x from "@phosphor-icons/core/regular/x.svg";
  import type { EditorService } from "../editor/service";
  import Slot from "../../kernel/slots/Slot.svelte";
  import { colors, fontSize, iconButton, iconButtonHover, radius } from "../theme/tokens";
  import { hunkPosition } from "./model";
  import type { DiffService } from "./service";

  interface Props {
    diff: DiffService;
    editor: EditorService;
    /** The pane this strip is over, and the document it shows. */
    leafId: string;
    documentId: number;
  }

  let { diff, editor, leafId, documentId }: Props = $props();

  const view = $derived(diff.inlineView(leafId, documentId));
  const cursorRow = $derived.by(() => {
    const cursor = editor.cursorOf(documentId);
    if (cursor === null) {
      return 0;
    }
    return cursor.row;
  });

  /** The look of a text button of the strip. */
  const textButton = { height: 24, paddingX: 6, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs } as const;

  /** Runs an action of the diff service on this pane's file: the pane has the focus first, since the actions work on the focused pane. */
  function act(action: () => Promise<void>): void {
    editor.focusPane(leafId);
    void action();
  }

  /** Opens the same comparison in a diff pane, beside the editor, and takes the strip's diff off. */
  function openPane(): void {
    if (view === undefined || view.gitBase === null) {
      return;
    }
    const path = view.path;
    const base = view.gitBase;
    void diff.hideInEditor();
    void diff.openFile(path, base);
  }
</script>

{#if view !== undefined}
  <View
    style={{
      direction: "row",
      align: "center",
      gap: 6,
      height: 28,
      shrink: 0,
      paddingX: 10,
      borderBottomWidth: 1,
      borderColor: colors.lineFaint,
    }}
  >
    <Text style={{ shrink: 0, paddingX: 6, radius: radius.sm, background: colors.raised, fontSize: fontSize.xxs, color: colors.muted }}>
      Changes vs {view.baseLabel}
    </Text>
    <View style={{ flex: 1 }} />
    <Slot name="diff.inline.actions" props={{ leafId, documentId, path: view.path }} />
    <Text style={{ shrink: 0, fontSize: fontSize.xxs, color: colors.dim }}>{hunkPosition(view.hunks, cursorRow)}</Text>
    <Tooltip text="Previous change (Alt+Up)" side="bottom" align="center">
      <Button style={{ ...iconButton, size: 22 }} hover={iconButtonHover} onpress={() => act(() => diff.stepChange(-1))}>
        <Icon svg={arrowUp} size={13} />
      </Button>
    </Tooltip>
    <Tooltip text="Next change (Alt+Down)" side="bottom" align="center">
      <Button style={{ ...iconButton, size: 22 }} hover={iconButtonHover} onpress={() => act(() => diff.stepChange(1))}>
        <Icon svg={arrowDown} size={13} />
      </Button>
    </Tooltip>
    {#if view.gitBase !== null}
      <Button style={textButton} hover={{ background: colors.hover, color: colors.text }} onpress={() => act(() => diff.stageHunk())}>
        <Icon svg={plus} size={12} />
        <Text>Stage</Text>
      </Button>
      <Button style={textButton} hover={{ background: colors.redSoft, color: colors.red }} onpress={() => act(() => diff.revertHunk())}>
        <Icon svg={arrowCounterClockwise} size={12} />
        <Text>Revert</Text>
      </Button>
      <Tooltip text="Side by side" side="bottom" align="center">
        <Button style={{ ...iconButton, size: 22 }} hover={iconButtonHover} onpress={openPane}>
          <Icon svg={columns} size={13} />
        </Button>
      </Tooltip>
    {/if}
    <Tooltip text="Close the diff" side="bottom" align="center">
      <Button style={{ ...iconButton, size: 22 }} hover={iconButtonHover} onpress={() => act(() => diff.hideInEditor())}>
        <Icon svg={x} size={13} />
      </Button>
    </Tooltip>
  </View>
{/if}
