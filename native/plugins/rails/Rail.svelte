<!--
  A vertical rail of icon buttons sitting on the canvas: the left activity bar and the right pane
  rail are the same component with different items. The active item (its pane is open) is
  raised; the others are dim until hovered.
-->
<script module lang="ts">
  export interface RailItem {
    id: string;
    /** SVG markup, tinted with the button's colour. */
    icon: string;
    title: string;
    order: number;
    active: boolean;
  }
</script>

<script lang="ts">
  import { Button, Icon, Tooltip, View } from "@neoworks/svelte-gpui/ui";
  import { colors, iconButton, iconButtonHover, size } from "../theme/tokens";

  interface Props {
    items: RailItem[];
    onselect: (id: string) => void;
    /** Which side the tooltips open on: toward the middle of the window. */
    tooltipSide?: "left" | "right";
  }

  let { items, onselect, tooltipSide = "right" }: Props = $props();

  const sortedItems = $derived([...items].sort((first, second) => first.order - second.order));
</script>

<View style={{ width: size.railWidth, shrink: 0, align: "center", gap: 4, paddingY: 8 }}>
  {#each sortedItems as item (item.id)}
    <Tooltip text={item.title} side={tooltipSide} align="center">
      <Button
        style={{
          ...iconButton,
          width: size.railButton,
          height: size.railButton,
          background: item.active ? colors.raised : "transparent",
          color: item.active ? colors.text : colors.dim,
        }}
        hover={item.active ? undefined : iconButtonHover}
        onpress={() => onselect(item.id)}
      >
        <Icon svg={item.icon} size={18} />
      </Button>
    </Tooltip>
  {/each}
</View>
