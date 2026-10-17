<!--
  One icon button of a rail. The active item (its pane is open) is raised; the others are dim
  until hovered. `active` is a function so the button follows state that changes under it.
-->
<script lang="ts">
  import { Button, Icon, Tooltip } from "@neoworks/svelte-gpui/ui";
  import { colors, iconButton, iconButtonHover, size } from "../theme/tokens";

  interface Props {
    /** SVG markup, tinted with the button's colour. */
    icon: string;
    title: string;
    active: () => boolean;
    onselect: () => void;
    /** Which side the tooltip opens on: toward the middle of the window. */
    tooltipSide?: "left" | "right";
  }

  let { icon, title, active, onselect, tooltipSide = "right" }: Props = $props();

  const isActive = $derived(active());
</script>

<Tooltip text={title} side={tooltipSide} align="center">
  <Button
    style={{
      ...iconButton,
      width: size.railButton,
      height: size.railButton,
      background: isActive ? colors.raised : "transparent",
      color: isActive ? colors.text : colors.dim,
    }}
    hover={isActive ? undefined : iconButtonHover}
    onpress={onselect}
  >
    <Icon svg={icon} size={18} />
  </Button>
</Tooltip>
