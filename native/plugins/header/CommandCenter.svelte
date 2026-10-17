<!-- The pill in the middle of the header: the project name, pressed to search files. -->
<script lang="ts">
  import { Button, Icon, Text } from "@neoworks/svelte-gpui/ui";
  import magnifyingGlass from "@phosphor-icons/core/regular/magnifying-glass.svg";
  import { colors, fontSize, radius, size } from "../theme/tokens";

  interface Props {
    label: string;
    onpress: () => void;
  }

  let { label, onpress }: Props = $props();
</script>

<Button
  style={{
    width: size.commandCenterWidth,
    maxWidth: "100%",
    height: 24,
    align: "center",
    justify: "center",
    gap: 8,
    paddingX: 12,
    radius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineFaint,
    background: colors.canvas,
    color: colors.dim,
    fontSize: fontSize.xs,
    transition: 120,
  }}
  hover={{ borderColor: colors.line, background: colors.hover, color: colors.text }}
  {onpress}
>
  <Icon svg={magnifyingGlass} size={13} />
  <Text style={{ nowrap: true }}>{label}</Text>
</Button>
