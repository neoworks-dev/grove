<!--
  A row of tabs that scrolls sideways when they do not fit. Tabs cut off at either edge are
  counted in a button on that edge, which brings the nearest one into view. Tab positions come
  from their measured widths, so they stay right while the row scrolls. Given `onclose`, each tab
  has a close button, which a middle click on the tab presses too, and a tab with unsaved
  changes shows a dot in its place until the pointer is over it.
-->
<script module lang="ts">
  export interface TabEntry {
    id: string;
    title: string;
    /** SVG markup. */
    icon?: string;
    /** The tab has unsaved changes. */
    dirty?: boolean;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import x from "@phosphor-icons/core/regular/x.svg";
  import { Button, Icon, Scroll, Text, View, type Layout, type ScrollPosition } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, radius, size } from "../theme/tokens";
  import { nextHiddenTab, revealScrollLeft, tabOverflow, type TabSpan } from "./tabOverflow";

  interface Props {
    tabs: TabEntry[];
    activeId: string;
    onselect: (id: string) => void;
    /** Gives every tab a close button, and a middle click closes it too. */
    onclose?: (id: string) => void;
    /** Drawn after the tabs, outside the scrolling row: the pane's controls. */
    trailing?: Snippet;
  }

  let { tabs, activeId, onselect, onclose, trailing }: Props = $props();

  const TAB_GAP = 4;
  /** How far an edge counter reaches into the row, so a revealed tab clears it. */
  const COUNTER_WIDTH = 36;

  let scroller: ReturnType<typeof Scroll> | undefined = $state();
  let scrollLeft = $state(0);
  let viewWidth = $state(0);
  let tabWidths = $state<Record<string, number>>({});
  /** The tab the pointer is over, whose dot gives way to the close icon. */
  let hoveredTabId = $state<string | null>(null);

  /** Where each tab sits in the scrolled row, from the widths measured so far. */
  const spans = $derived.by(() => {
    const result: TabSpan[] = [];
    let start = 0;
    for (const tab of tabs) {
      const width = tabWidths[tab.id] ?? 0;
      result.push({ start, end: start + width });
      start += width + TAB_GAP;
    }
    return result;
  });

  /** The row's full width, which the scroller cannot work out from tabs that overflow it. */
  const contentWidth = $derived(spans.length === 0 ? 0 : spans[spans.length - 1].end);

  const overflow = $derived(tabOverflow(spans, scrollLeft, scrollLeft + viewWidth));

  /** Records one tab's width when it is laid out or resized. */
  function measureTab(tabId: string, layout: Layout): void {
    tabWidths[tabId] = layout.width;
  }

  /** Remembers which tab the pointer is over. */
  function trackHover(tabId: string, hovered: boolean): void {
    if (hovered) {
      hoveredTabId = tabId;
      return;
    }
    if (hoveredTabId === tabId) {
      hoveredTabId = null;
    }
  }

  /** Follows the row's scroll position. */
  function trackScroll(position: ScrollPosition): void {
    scrollLeft = position.x;
  }

  /** Scrolls the nearest tab cut off on `side` into view, clear of the counters. */
  function revealNext(side: "left" | "right"): void {
    const index = nextHiddenTab(spans, scrollLeft, scrollLeft + viewWidth, side);
    if (index === -1) {
      return;
    }
    const target = revealScrollLeft(spans[index], scrollLeft, scrollLeft + viewWidth, {
      left: COUNTER_WIDTH,
      right: COUNTER_WIDTH,
    });
    scroller?.scrollTo(Math.max(0, target));
  }
</script>

{#snippet counter(side: "left" | "right", count: number)}
  <Button
    style={{
      position: "absolute",
      top: 0,
      bottom: 0,
      [side]: 0,
      width: COUNTER_WIDTH,
      align: "center",
      justify: "center",
      background: colors.surface,
      fontSize: fontSize.xxs,
      color: colors.muted,
    }}
    hover={{ color: colors.text }}
    onpress={() => revealNext(side)}
  >
    <Text>{side === "left" ? `‹ ${count}` : `${count} ›`}</Text>
  </Button>
{/snippet}

<View
  style={{
    direction: "row",
    align: "center",
    height: size.tabStripHeight,
    shrink: 0,
    paddingX: 4,
    gap: 4,
    borderBottomWidth: 1,
    borderColor: colors.line,
  }}
>
  <View style={{ flex: 1, minWidth: 0, height: "100%", justify: "center" }}>
    <Scroll bind:this={scroller} horizontal style={{ height: "100%" }} onscroll={trackScroll} onlayout={(layout) => (viewWidth = layout.width)}>
      <View style={{ direction: "row", align: "center", gap: TAB_GAP, height: "100%", shrink: 0, width: contentWidth }}>
        {#each tabs as tab (tab.id)}
          {@const active = tab.id === activeId}
          <View
            buttons={["middle"]}
            ondown={() => onclose?.(tab.id)}
            onhover={(hovered) => trackHover(tab.id, hovered)}
            style={{
              shrink: 0,
              direction: "row",
              align: "center",
              radius: radius.sm,
              fontSize: fontSize.xs,
              background: active ? colors.hover : "transparent",
              color: active ? colors.text : colors.dim,
              transition: 120,
            }}
            onresize={(layout) => measureTab(tab.id, layout)}
          >
            <Button
              style={{ direction: "row", align: "center", gap: 6, paddingLeft: 8, paddingRight: onclose ? 2 : 8, paddingY: 4 }}
              hover={{ color: colors.text }}
              onpress={() => onselect(tab.id)}
            >
              {#if tab.icon}<Icon svg={tab.icon} size={14} />{/if}
              <Text style={{ nowrap: true }}>{tab.title}</Text>
            </Button>
            {#if onclose}
              <Button
                style={{ size: 18, align: "center", justify: "center", shrink: 0, radius: radius.sm, marginRight: 4, color: colors.dim }}
                hover={{ background: colors.raised, color: colors.text }}
                onpress={() => onclose(tab.id)}
              >
                {#if tab.dirty && hoveredTabId !== tab.id}
                  <Text style={{ color: colors.amber, fontSize: fontSize.xs }}>●</Text>
                {:else}
                  <Icon svg={x} size={12} />
                {/if}
              </Button>
            {/if}
          </View>
        {/each}
      </View>
    </Scroll>
    {#if overflow.left > 0}{@render counter("left", overflow.left)}{/if}
    {#if overflow.right > 0}{@render counter("right", overflow.right)}{/if}
  </View>
  {@render trailing?.()}
</View>
