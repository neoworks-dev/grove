<!--
  The picker's card: a search field over the results on the left and a preview of the selected
  one on the right. A `filter` source loads once and the query ranks what it loaded; a `live`
  source is asked again once typing pauses, and a slower answer for an older query is dropped.
  Up and Down (or Ctrl-N and Ctrl-P) move the highlight, Enter chooses and Escape closes.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { Input, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import type { EditorService } from "../editor/service";
  import { colors, fontSize, overlayPanel, radius } from "../theme/tokens";
  import PickerPreview from "./PickerPreview.svelte";
  import type { PickerItem, PickerService, PickerSession } from "./service";

  interface Props {
    picker: PickerService;
    session: PickerSession;
    editor: EditorService;
  }

  const ROW_HEIGHT = 28;
  const BODY_HEIGHT = 392;
  /** The most rows a ranked list shows; the rest of a long list is a keystroke away. */
  const MAX_SHOWN = 200;
  /** How long typing must pause before a live source is asked. */
  const SEARCH_DELAY_MS = 120;

  let { picker, session, editor }: Props = $props();

  const source = untrack(() => session.source);
  // A live source's titles are whole lines of text, which give way to the place after them; a filter
  // source's titles are file names, which keep their room while the directory after them gives way.
  const titleStyle = { ...titleLayout(), nowrap: true };
  const detailStyle = { ...detailLayout(), nowrap: true };

  let query = $state("");
  let highlighted = $state(0);
  let loaded = $state<PickerItem[]>([]);
  let message = $state("");
  let loading = $state(true);
  let input: ReturnType<typeof Input> | undefined = $state();
  let list: ReturnType<typeof List<PickerItem>> | undefined = $state();
  let latestLoad = 0;

  const items = $derived.by(() => {
    if (source.mode === "live") {
      return loaded;
    }
    return picker.rank(loaded, query).slice(0, MAX_SHOWN);
  });
  const target = $derived.by(() => {
    const item = items[highlighted];
    if (item === undefined) {
      return null;
    }
    return item.target;
  });
  const highlightedLocation = $derived.by(() => {
    const item = items[highlighted];
    if (item === undefined || item.location === undefined) {
      return "";
    }
    return item.location;
  });
  const status = $derived.by(() => {
    if (loading) {
      return "Searching…";
    }
    if (items.length === 0 && message === "") {
      return "Nothing matches";
    }
    return message;
  });

  $effect(() => {
    input?.focus();
  });

  // A filter source is read once, when the card opens.
  $effect(() => {
    if (source.mode === "filter") {
      void load("");
    }
  });

  // A live source is asked once typing pauses.
  $effect(() => {
    const wanted = query;
    if (source.mode !== "live") {
      return;
    }
    const timer = setTimeout(() => void load(wanted), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  });

  /** Loads the items for a query; an answer that arrives after a newer request was made is dropped. */
  async function load(wanted: string): Promise<void> {
    latestLoad += 1;
    const request = latestLoad;
    loading = true;
    const result = await source.load(wanted);
    if (request !== latestLoad) {
      return;
    }
    loaded = result.items;
    message = "";
    if (result.message !== undefined) {
      message = result.message;
    }
    loading = false;
    if (source.mode === "live") {
      highlighted = 0;
    }
  }

  /** Moves the highlight by `step` rows, stopping at the ends, and keeps it in view. */
  function move(step: number): void {
    if (items.length === 0) {
      return;
    }
    highlighted = Math.min(Math.max(highlighted + step, 0), items.length - 1);
    list?.scrollToIndex(highlighted, { align: "nearest" });
  }

  /** How a row's title takes room: a line of text takes what the detail leaves, a file name keeps its own. */
  function titleLayout(): { flex?: number; minWidth?: number; truncate?: boolean; shrink?: number } {
    if (source.mode === "live") {
      return { flex: 1, minWidth: 0, truncate: true };
    }
    return { shrink: 0 };
  }

  /** How a row's detail takes room: the place after a line of text keeps its own, a directory takes what is left. */
  function detailLayout(): { flex?: number; minWidth?: number; shrink?: number; truncate?: boolean } {
    if (source.mode === "live") {
      return { shrink: 0 };
    }
    return { flex: 1, minWidth: 0, truncate: true };
  }

  /** The background of a row: raised while it is the highlighted one. */
  function rowBackground(index: number): string {
    if (index === highlighted) {
      return colors.hover;
    }
    return "transparent";
  }

  /** Highlights the row the pointer entered. */
  function highlightOnHover(hovered: boolean, index: number): void {
    if (hovered) {
      highlighted = index;
    }
  }

  /** Chooses the highlighted row, if there is one. */
  function chooseHighlighted(): void {
    const item = items[highlighted];
    if (item) {
      picker.choose(item);
    }
  }

  /** Takes a new query and highlights the best row for it. */
  function search(value: string): void {
    query = value;
    highlighted = 0;
    list?.scrollToIndex(0, { align: "start" });
  }

  /** Handles the keys that steer the list; everything else types into the field. */
  function onKey(event: KeyEvent): void {
    if (event.key === "ArrowDown" || (event.ctrl && event.key === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (event.ctrl && event.key === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseHighlighted();
    } else if (event.key === "Escape") {
      event.preventDefault();
      picker.close();
    }
  }
</script>

<View style={{ ...overlayPanel, width: 1080, maxWidth: "94%", paddingY: 0, overflow: "hidden" }} onpress={() => input?.focus()}>
  <Input
    bind:this={input}
    value={query}
    placeholder={source.placeholder}
    oninput={search}
    onkey={onKey}
    style={{
      paddingX: 14,
      paddingY: 12,
      fontSize: fontSize.sm,
      color: colors.text,
      borderBottomWidth: 1,
      borderColor: colors.line,
    }}
  />
  <View style={{ direction: "row", height: BODY_HEIGHT }}>
    <View style={{ flex: 4, minWidth: 0, borderRightWidth: 1, borderColor: colors.line }}>
      {#if items.length === 0}
        <Text style={{ padding: 14, fontSize: fontSize.xs, color: colors.dim }}>{status}</Text>
      {:else}
        <List bind:this={list} {items} rowHeight={ROW_HEIGHT} key={(item) => item.id} style={{ flex: 1, marginY: 4 }}>
          {#snippet row(item, index)}
            <View
              style={{
                direction: "row",
                align: "center",
                gap: 8,
                height: ROW_HEIGHT,
                marginX: 4,
                paddingX: 10,
                radius: radius.md,
                background: rowBackground(index),
              }}
              onpress={() => picker.choose(item)}
              onhover={(hovered) => highlightOnHover(hovered, index)}
            >
              <Text style={{ ...titleStyle, fontSize: fontSize.sm, color: colors.text }}>{item.title}</Text>
              {#if item.detail}
                <Text style={{ ...detailStyle, fontSize: fontSize.xxs, color: colors.dim }}>{item.detail}</Text>
              {/if}
            </View>
          {/snippet}
        </List>
      {/if}
    </View>
    <View style={{ flex: 5, minWidth: 0 }}>
      <PickerPreview {editor} {target} />
    </View>
  </View>
  <View style={{ direction: "row", align: "center", gap: 12, height: 26, paddingX: 14, borderTopWidth: 1, borderColor: colors.line }}>
    <Text style={{ shrink: 0, fontSize: fontSize.xxs, color: colors.dim, nowrap: true }}>{status}</Text>
    <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xxs, color: colors.muted, nowrap: true, truncate: true, textAlign: "right" }}>{highlightedLocation}</Text>
  </View>
</View>
