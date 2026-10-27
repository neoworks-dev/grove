<!--
  The cards of review comments, drawn over the text of an editor pane. The editor reserves blank
  rows under a line (a block with a key) and says where they are; this lays the cards over them:
  each saved comment with its edit and delete buttons, and the input a new or edited comment is
  typed in. Enter saves, Shift-Enter breaks the line, and Esc cancels.
-->
<script lang="ts">
  import { Button, Input, Scroll, Text, View, type KeyEvent } from "@neoworks/svelte-gpui/ui";
  import type { EditorService, TabKind } from "../editor/service";
  import { colors, fontSize, radius } from "../theme/tokens";
  import { DRAFT_ROWS, EDITOR_LINE_HEIGHT, wrapText } from "./model";
  import { rowOfBlockKey, type ReviewCommentsService } from "./service";

  interface Props {
    review: ReviewCommentsService;
    editor: EditorService;
    leafId: string;
    documentId: number;
    /** Where the editor says its lines and keyed blocks are, in pixels from the top left of the editor. */
    places: {
      textLeft: number;
      lineHeight: number;
      rows: { row: number; top: number }[];
      blocks: { key: string; top: number; height: number }[];
    };
    /** Space kept free at the right edge, for the minimap. */
    rightInset: number;
    /** What the pane's tab shows of the document; comments are offered on a diff tab only. */
    tabKind: TabKind;
  }

  let { review, leafId, documentId, places, rightInset, tabKind }: Props = $props();

  /** The height of the card's header row; the card's border takes the rest of a row. */
  const HEADER_HEIGHT = EDITOR_LINE_HEIGHT - 2;

  /** The width of the strip at the left edge of the gutter, where the "+" is offered. */
  const PLUS_WIDTH = 16;

  let hoveredRow = $state<number | null>(null);
  const commentable = $derived.by(() => {
    if (tabKind !== "diff") {
      return [];
    }
    const rows = new Set(review.rowsFor(leafId, documentId));
    return places.rows.filter((place) => rows.has(place.row));
  });

  let field = $state<{ focus(): void } | null | undefined>();
  let typed = $state("");

  // A new input starts empty, or with the text of the comment it edits, and takes the keyboard.
  $effect(() => {
    if (field === undefined || field === null) {
      return;
    }
    typed = review.draftText();
    field.focus();
  });

  /** The look of a small text button in a card's header. */
  const textButton = { height: HEADER_HEIGHT - 2, paddingX: 6, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs } as const;

  /** The fill of a row's "+": it only shows while the pointer is on it. */
  function plusBackground(row: number): string {
    if (hoveredRow === row) {
      return colors.blue;
    }
    return "transparent";
  }

  /** The colour of a row's "+" sign, which is there for the pointer to find but invisible until it is on it. */
  function plusColor(row: number): string {
    if (hoveredRow === row) {
      return colors.inverse;
    }
    return "transparent";
  }

  /** Remembers which row's "+" the pointer is on. */
  function hover(row: number, hovered: boolean): void {
    if (hovered) {
      hoveredRow = row;
      return;
    }
    if (hoveredRow === row) {
      hoveredRow = null;
    }
  }

  /** Enter saves, Shift-Enter and Alt-Enter break the line, Esc cancels. */
  function key(event: KeyEvent): void {
    if (event.key === "Enter" && !event.shift && !event.alt) {
      event.preventDefault();
      review.setDraftText(typed);
      void review.saveDraft();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      review.cancelDraft();
    }
  }

  /** What the input's header says it is for. */
  function draftTitle(editing: boolean): string {
    if (editing) {
      return "Edit the comment on";
    }
    return "Comment on";
  }

  /** The lines a comment is on, as people count them: "line 12" or "lines 12 to 14". */
  function rowsLabel(startRow: number, endRow: number): string {
    if (startRow === endRow) {
      return `line ${endRow + 1}`;
    }
    return `lines ${startRow + 1} to ${endRow + 1}`;
  }
</script>

{#each commentable as place (place.row)}
  <View
    style={{
      position: "absolute",
      top: place.top,
      left: 2,
      width: PLUS_WIDTH,
      height: places.lineHeight,
      align: "center",
      justify: "center",
      radius: radius.sm,
      cursor: "pointer",
      background: plusBackground(place.row),
    }}
    onhover={(hovered) => hover(place.row, hovered)}
    onpress={() => void review.beginOnRow(leafId, documentId, place.row)}
  >
    <Text style={{ fontSize: fontSize.sm, lineHeight: places.lineHeight, color: plusColor(place.row) }}>+</Text>
  </View>
{/each}

{#each places.blocks as place (place.key)}
  {@const row = rowOfBlockKey(place.key)}
  {#if row !== null}
    <View style={{ position: "absolute", top: place.top, left: places.textLeft, right: rightInset, height: place.height }}>
      {#each review.cardsAt(leafId, documentId, row) as card (card.id)}
        {#if card.kind === "comment"}
          <View
            style={{
              height: card.rows * EDITOR_LINE_HEIGHT,
              paddingX: 8,
              background: colors.elevated,
              borderWidth: 1,
              borderColor: colors.lineStrong,
              radius: radius.md,
              overflow: "hidden",
            }}
          >
            <View style={{ direction: "row", align: "center", gap: 6, height: HEADER_HEIGHT }}>
              <Text style={{ fontSize: fontSize.xxs, color: colors.muted, flex: 1, truncate: true }}>
                Comment on {rowsLabel(card.comment.startRow, card.comment.endRow)}
              </Text>
              {#if card.comment.outdated}
                <Text style={{ fontSize: fontSize.xxs, color: colors.amber, shrink: 0 }}>Outdated</Text>
              {/if}
              <Button style={textButton} hover={{ background: colors.hover, color: colors.text }} onpress={() => void review.edit(card.comment.id)}>
                <Text>Edit comment</Text>
              </Button>
              <Button style={textButton} hover={{ background: colors.redSoft, color: colors.red }} onpress={() => void review.remove(card.comment.id)}>
                <Text>Delete comment</Text>
              </Button>
            </View>
            {#each wrapText(card.comment.text) as line}
              <Text style={{ height: EDITOR_LINE_HEIGHT, lineHeight: EDITOR_LINE_HEIGHT, fontSize: fontSize.sm, color: colors.text, truncate: true }}>{line}</Text>
            {/each}
          </View>
        {:else}
          <View
            style={{
              height: DRAFT_ROWS * EDITOR_LINE_HEIGHT,
              paddingX: 8,
              background: colors.elevated,
              borderWidth: 1,
              borderColor: colors.accent,
              radius: radius.md,
              overflow: "hidden",
            }}
          >
            <View style={{ direction: "row", align: "center", gap: 6, height: HEADER_HEIGHT }}>
              <Text style={{ fontSize: fontSize.xxs, color: colors.muted, flex: 1, truncate: true }}>
                {draftTitle(card.editing)} {rowsLabel(card.range.startRow, card.range.endRow)}
              </Text>
              <Text style={{ fontSize: fontSize.xxs, color: colors.dim, shrink: 0 }}>Enter saves, Shift+Enter breaks the line, Esc cancels</Text>
            </View>
            <Scroll style={{ height: (DRAFT_ROWS - 1) * EDITOR_LINE_HEIGHT }}>
              <Input
                bind:this={field}
                bind:value={typed}
                multiline
                rows={3}
                placeholder="Say what should change"
                style={{ color: colors.text, fontSize: fontSize.sm, lineHeight: EDITOR_LINE_HEIGHT }}
                oninput={(text) => review.setDraftText(text)}
                onkey={key}
              />
            </Scroll>
          </View>
        {/if}
      {/each}
    </View>
  {/if}
{/each}
