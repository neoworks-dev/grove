<!--
  The resize handle between two siblings of a split: an empty gap the panes sit apart in, with a
  thin bar that shows on hover and while dragging, and a "+" that asks for a pane to be opened
  there. Dragging, or the arrow keys, moves the boundary; the arithmetic is in `gutterDrag.ts`.
-->
<script lang="ts">
  import { Button, Icon, Overlay, View, type KeyEvent, type PointerEvent } from "@neoworks/svelte-gpui/ui";
  import plus from "@phosphor-icons/core/bold/plus-bold.svg";
  import { colors, size } from "../theme/tokens";
  import { GutterDrag } from "./gutterDrag";
  import type { LayoutHost } from "./host";
  import type { SplitNode } from "./layoutTree";

  interface Props {
    split: SplitNode;
    gutterIndex: number;
    host: LayoutHost;
    /** Pixels of the two panes either side, together, as last measured. */
    pairPx: number;
  }

  let { split, gutterIndex, host, pairPx }: Props = $props();

  const horizontal = $derived(split.direction === "row");

  let dragging = $state(false);
  let hovered = $state(false);
  let plusHovered = $state(false);

  const drag = new GutterDrag(() => ({ host, split, gutterIndex, pairPx }));

  /** The pointer's position along the split's axis, in the window. */
  function positionOf(event: PointerEvent): number {
    if (horizontal) {
      return event.windowX;
    }
    return event.windowY;
  }

  function onDown(event: PointerEvent): void {
    dragging = true;
    drag.start(positionOf(event));
  }

  function onMove(event: PointerEvent): void {
    drag.move(positionOf(event));
  }

  function onUp(): void {
    dragging = false;
    drag.end();
  }

  /** Arrow keys move the boundary for those who do not drag. */
  function onKey(event: KeyEvent): void {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      drag.nudge(1);
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      drag.nudge(-1);
    }
  }

  const barColor = $derived.by(() => {
    if (dragging) {
      return colors.accent;
    }
    if (hovered) {
      return colors.lineStrong;
    }
    return "transparent";
  });

  const showPlus = $derived(host.addPaneAtGutter !== undefined && !dragging && (hovered || plusHovered));
</script>

<View
  focusable
  buttons={["left"]}
  style={{
    shrink: 0,
    width: horizontal ? size.gutter : undefined,
    height: horizontal ? undefined : size.gutter,
    align: "center",
    justify: "center",
    cursor: horizontal ? "col-resize" : "row-resize",
  }}
  ondown={onDown}
  onmove={onMove}
  onup={onUp}
  onhover={(value) => (hovered = value)}
  onkey={onKey}
>
  <View
    style={{
      width: horizontal ? 2 : "100%",
      height: horizontal ? "100%" : 2,
      radius: 1,
      background: barColor,
      transition: 120,
    }}
  />
  {#if showPlus}
    <Overlay side={horizontal ? "right" : "bottom"} align="center" offset={-14} shift={false} flip={false}>
      <Button
        style={{
          size: 20,
          align: "center",
          justify: "center",
          radius: 10,
          borderWidth: 1,
          borderColor: colors.line,
          background: colors.elevated,
          color: colors.dim,
        }}
        hover={{ color: colors.text }}
        onhover={(value) => (plusHovered = value)}
        onpress={() => host.addPaneAtGutter?.(split.id, gutterIndex)}
      >
        <Icon svg={plus} size={11} />
      </Button>
    </Overlay>
  {/if}
</View>
