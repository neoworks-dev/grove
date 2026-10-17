<!-- A small icon button for a pane's header or a row, as `RowAction` was in the web app. -->
<script lang="ts">
  import { Button, Icon, Tooltip } from "@neoworks/svelte-gpui/ui";
  import { colors, radius } from "../theme/tokens";

  interface Props {
    /** SVG markup. */
    icon: string;
    title: string;
    disabled?: boolean;
    onpress: () => void;
  }

  let { icon, title, disabled = false, onpress }: Props = $props();
</script>

<Tooltip text={title} anchorStyle={{ alignSelf: "center" }}>
  <Button
    {disabled}
    style={{ size: 20, align: "center", justify: "center", shrink: 0, radius: radius.sm, color: colors.dim, transition: 120 }}
    hover={{ background: colors.raised, color: colors.text }}
    disabledStyle={{ opacity: 0.4 }}
    {onpress}
  >
    <Icon svg={icon} size={14} />
  </Button>
</Tooltip>
