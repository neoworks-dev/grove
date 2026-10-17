<!--
  A leaf of the split tree: a rounded panel with a header (the title, which picks the pane up,
  and its close button) over the pane's own content. Another pane dragged over it shows where it
  would land, in the middle to replace this one or on an edge to split it, by the zones in
  `paneDragCore.ts`. The focused pane shows a faint line of light along its bottom edge.
-->
<script module lang="ts">
  /** What a pane carries while it is dragged. */
  export interface DraggedPane {
    leafId: string;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { Draggable, DropTarget, Icon, Text, View, type DragInfo } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, pane } from "../theme/tokens";
  import PaneControls from "./PaneControls.svelte";
  import type { DropZone } from "./layoutTree";
  import { dropZoneAt, placeholderRect, type Rect } from "./paneDragCore";

  interface Props {
    leafId: string;
    title: string;
    /** SVG markup. */
    icon?: string;
    /** This is the focused pane. */
    active?: boolean;
    onclose?: () => void;
    /** Another pane was dropped here, on `zone`. */
    ondroppane?: (draggedLeafId: string, zone: DropZone) => void;
    children: Snippet;
  }

  let { leafId, title, icon, active = false, onclose, ondroppane, children }: Props = $props();

  let zone = $state<DropZone | null>(null);
  let targetRect = $state<Rect>({ left: 0, top: 0, width: 0, height: 0 });

  const placeholder = $derived(zone === null ? null : placeholderRect(targetRect, zone));

  /** Another pane, not this one, may be dropped here. */
  function acceptsPane(data: DraggedPane): boolean {
    return data.leafId !== leafId;
  }

  /** Works out which zone the pointer is in. */
  function onDragOver(info: DragInfo<DraggedPane>): void {
    targetRect = { left: 0, top: 0, width: info.width, height: info.height };
    zone = dropZoneAt(info.x / info.width, info.y / info.height);
  }

  function onDrop(info: DragInfo<DraggedPane>): void {
    const dropZone = zone ?? "center";
    zone = null;
    ondroppane?.(info.data.leafId, dropZone);
  }
</script>

<DropTarget
  accept={acceptsPane}
  ondragover={onDragOver}
  ondragleave={() => (zone = null)}
  ondrop={onDrop}
  style={{ ...pane, flex: 1, minWidth: 0, minHeight: 0 }}
>
  <Draggable
    data={{ leafId }}
    style={{ direction: "row", align: "center", height: 28, shrink: 0, paddingLeft: 12, paddingRight: 4, gap: 6, cursor: "grab" }}
  >
    {#if icon}<Icon svg={icon} size={14} color={colors.dim} />{/if}
    <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xs, color: colors.muted }}>{title}</Text>
    {#if onclose}<PaneControls {onclose} />{/if}
  </Draggable>
  <View style={{ flex: 1, minHeight: 0 }}>
    {@render children()}
  </View>
  <View
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: 3,
      background: colors.blueGlow,
      opacity: active ? 1 : 0,
      transition: 140,
    }}
  />
  {#if placeholder}
    <View
      style={{
        position: "absolute",
        left: placeholder.left,
        top: placeholder.top,
        width: placeholder.width,
        height: placeholder.height,
        background: colors.blueGlow,
        borderWidth: 1,
        borderColor: colors.blue,
        radius: 8,
      }}
    />
  {/if}
</DropTarget>
