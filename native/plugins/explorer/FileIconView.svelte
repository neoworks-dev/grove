<!--
  One icon of the explorer's tree. A glyph is tinted with the colour it is given (the set's own,
  else the one the tree passes for the row); a picture keeps the colours it was drawn in.
-->
<script lang="ts">
  import { Icon, Image } from "@neoworks/svelte-gpui/ui";
  import type { FileIcon } from "./fileIcons";

  interface Props {
    icon: FileIcon;
    /** Pixels. */
    size: number;
    /** What a glyph without a colour of its own is drawn in. */
    fallbackColor: string;
  }

  let { icon, size, fallbackColor }: Props = $props();

  /** The glyph's own colour when the set gives one. */
  const glyphColor = $derived.by(() => {
    if (icon.color === undefined) {
      return fallbackColor;
    }
    return icon.color;
  });
</script>

{#if icon.image !== undefined}
  <Image src={icon.image} fit="contain" style={{ width: size, height: size, shrink: 0 }} />
{:else if icon.svg !== undefined}
  <Icon svg={icon.svg} {size} color={glyphColor} />
{/if}
