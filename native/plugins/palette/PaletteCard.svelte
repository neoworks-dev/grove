<!--
  The palette's card: a search field over the ranked list. Typing narrows the list, the arrow
  keys (or ctrl+j and ctrl+k) move the highlight, Enter chooses and Escape closes.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { Input, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, overlayPanel, radius } from "../theme/tokens";
  import { rankItems } from "./fuzzy";
  import type { PaletteItem, PaletteService, PaletteSession } from "./service";

  interface Props {
    palette: PaletteService;
    session: PaletteSession;
  }

  const ROW_HEIGHT = 34;
  const MAX_ROWS = 10;

  let { palette, session }: Props = $props();

  let query = $state("");
  let highlighted = $state(startIndex());
  let input: ReturnType<typeof Input> | undefined = $state();
  let list: ReturnType<typeof List<PaletteItem>> | undefined = $state();

  const items = $derived(rankItems(palette.itemsFor(session), query));
  const listHeight = $derived(Math.min(items.length, MAX_ROWS) * ROW_HEIGHT);

  $effect(() => {
    input?.focus();
  });

  /** The row that starts highlighted: the session's active item, else the first. */
  function startIndex(): number {
    const index = untrack(() => palette.itemsFor(session)).findIndex((item) => item.id === session.activeId);
    return Math.max(index, 0);
  }

  /** Moves the highlight by `step` rows, stopping at the ends, and keeps it in view. */
  function move(step: number): void {
    if (items.length === 0) {
      return;
    }
    highlighted = Math.min(Math.max(highlighted + step, 0), items.length - 1);
    list?.scrollToIndex(highlighted, { align: "nearest" });
  }

  /** Chooses the highlighted row, if the query left any. */
  function chooseHighlighted(): void {
    const item = items[highlighted];
    if (item) {
      palette.choose(item);
    }
  }

  /** Narrows the list to the query and highlights its best match. */
  function search(value: string): void {
    query = value;
    highlighted = 0;
  }

  /** Handles the keys that steer the list; everything else types into the field. */
  function onKey(event: KeyEvent): void {
    if (event.key === "ArrowDown" || (event.ctrl && event.key === "j")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (event.ctrl && event.key === "k")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseHighlighted();
    } else if (event.key === "Escape") {
      event.preventDefault();
      palette.close();
    }
  }
</script>

<View style={{ ...overlayPanel, width: 560, maxWidth: "92%", paddingY: 0, overflow: "hidden" }} onpress={() => input?.focus()}>
  <Input
    bind:this={input}
    value={query}
    placeholder={session.placeholder}
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
  {#if items.length === 0}
    <Text style={{ padding: 14, fontSize: fontSize.xs, color: colors.dim }}>Nothing matches</Text>
  {:else}
    <List bind:this={list} {items} rowHeight={ROW_HEIGHT} key={(item) => item.id} style={{ height: listHeight, marginY: 4 }}>
      {#snippet row(item, index)}
        <View
          style={{
            direction: "row",
            align: "center",
            gap: 10,
            height: ROW_HEIGHT,
            marginX: 4,
            paddingX: 10,
            radius: radius.md,
            background: index === highlighted ? colors.hover : "transparent",
          }}
          onpress={() => palette.choose(item)}
          onhover={(hovered) => hovered && (highlighted = index)}
        >
          <Text style={{ fontSize: fontSize.sm, color: colors.text, nowrap: true }}>{item.title}</Text>
          {#if item.detail}
            <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xxs, color: colors.dim, truncate: true }}>{item.detail}</Text>
          {:else}
            <View style={{ flex: 1 }} />
          {/if}
          {#if item.keys && item.keys.length > 0}
            <View style={{ direction: "row", gap: 3 }}>
              {#each item.keys as key}
                <Text
                  style={{
                    paddingX: 5,
                    paddingY: 1,
                    radius: radius.sm,
                    background: colors.lineFaint,
                    fontSize: fontSize.xxs,
                    fontFamily: "mono",
                    color: colors.muted,
                  }}>{key}</Text
                >
              {/each}
            </View>
          {/if}
        </View>
      {/snippet}
    </List>
  {/if}
</View>
