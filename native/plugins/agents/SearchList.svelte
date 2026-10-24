<!--
  The list of a dropdown with many options, such as every model a provider offers: a search field
  over a list that only builds the rows in view, so it opens at once however long it is. Up and
  Down move the highlight, Enter picks it.
-->
<script lang="ts">
  import { Button, Icon, Input, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import check from "@phosphor-icons/core/regular/check.svg";
  import magnifier from "@phosphor-icons/core/regular/magnifying-glass.svg";
  import { colors } from "../theme/tokens";
  import { palette } from "./palette";

  interface Option {
    value: string;
    label: string;
  }

  interface Props {
    value: string;
    options: Option[];
    onpick: (value: string) => void;
  }

  let { value, options, onpick }: Props = $props();

  const p = palette;
  const ROW_HEIGHT = 30;
  const MAX_ROWS = 10;
  /** The column in front of each label, for the check mark; the search field's magnifier sits in it too, so the texts line up. */
  const MARK_WIDTH = 14;

  let query = $state("");
  let highlighted = $state(0);
  let list: { scrollToIndex(index: number, options: { align: "nearest" }): void } | undefined = $state();

  const shown = $derived(matching(options, query));
  const listHeight = $derived(Math.max(1, Math.min(shown.length, MAX_ROWS)) * ROW_HEIGHT);

  /** A label split at its last ` · `, so `Model · provider` shows the provider apart and quieter. */
  function parts(label: string): { name: string; source?: string } {
    const at = label.lastIndexOf(" · ");
    if (at <= 0) {
      return { name: label };
    }
    return { name: label.slice(0, at), source: label.slice(at + 3) };
  }

  /** The options whose label or value holds every word of the query, in their order. */
  function matching(all: Option[], text: string): Option[] {
    const words = text.toLowerCase().split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) {
      return all;
    }
    return all.filter((option) => {
      const haystack = `${option.label} ${option.value}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  /** Moves the highlight by `step` rows, kept inside the list, and scrolls it into view. */
  function move(step: number): void {
    if (shown.length === 0) {
      return;
    }
    highlighted = Math.max(0, Math.min(shown.length - 1, highlighted + step));
    list?.scrollToIndex(highlighted, { align: "nearest" });
  }

  /** Up and Down move the highlight, Enter picks the highlighted option. */
  function key(event: KeyEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter" && shown[highlighted] !== undefined) {
      event.preventDefault();
      onpick(shown[highlighted].value);
    }
  }
</script>

<View style={{ padding: p.space.s }}>
  <View
    style={{
      direction: "row",
      align: "center",
      gap: p.space.m,
      height: ROW_HEIGHT + p.space.s,
      paddingX: p.space.m,
      marginBottom: p.space.s,
      borderBottomWidth: 1,
      borderColor: p.border,
      color: p.muted,
    }}
  >
    <View style={{ width: MARK_WIDTH, shrink: 0, align: "center" }}>
      <Icon svg={magnifier} size={12} />
    </View>
    <Input
      bind:value={query}
      placeholder="Search"
      style={{ flex: 1, minWidth: 0, color: p.fg, fontSize: p.text.code, lineHeight: 18 }}
      oninput={() => (highlighted = 0)}
      onkey={key}
    />
  </View>
  {#if shown.length === 0}
    <View style={{ height: ROW_HEIGHT, justify: "center", paddingX: p.space.m }}>
      <Text style={{ color: p.muted, fontSize: p.text.code }}>Nothing matches</Text>
    </View>
  {:else}
    <List bind:this={list} items={shown} rowHeight={ROW_HEIGHT} key={(option: Option) => option.value} style={{ height: listHeight }}>
      {#snippet row(option: Option, index: number)}
        {@const label = parts(option.label)}
        <Button
          onpress={() => onpick(option.value)}
          style={{
            direction: "row",
            align: "center",
            gap: p.space.m,
            height: ROW_HEIGHT,
            paddingX: p.space.m,
            radius: 4,
            color: p.fg,
            background: index === highlighted ? colors.hover : "transparent",
          }}
          hover={{ background: colors.hover }}
        >
          <View style={{ width: MARK_WIDTH, shrink: 0, align: "center" }}>
            {#if option.value === value}
              <Icon svg={check} size={12} />
            {/if}
          </View>
          <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: p.text.code }}>{label.name}</Text>
          {#if label.source !== undefined}
            <Text style={{ shrink: 0, nowrap: true, color: p.muted, fontSize: p.text.code }}>{label.source}</Text>
          {/if}
        </Button>
      {/snippet}
    </List>
  {/if}
</View>
