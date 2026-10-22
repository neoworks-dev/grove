<script lang="ts">
  // Several pictures of one subject: the first large, up to three more small beside it, and the
  // number left out. Narrow, only the large one. Every picture has its own box.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { galleryParts, pictureName } from "./image";
  import OpenImage from "./OpenImage.svelte";
  import { nodes, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;

  const images = $derived(nodes(node, "images"));
  const parts = $derived(galleryParts(images));
  const narrow = $derived(width < 300);
  const gap = 8;
  const largeWidth = $derived(narrow || parts.small.length === 0 ? Math.min(width, 520) : Math.floor((width - gap) * 0.6));
  const largeHeight = $derived(Math.round(largeWidth * 0.66));
  const smallHeight = $derived(Math.floor((largeHeight - gap * (parts.small.length - 1)) / Math.max(1, parts.small.length)));
  const smallWidth = $derived(width - gap - largeWidth);
  const hidden = $derived(parts.more + (narrow ? parts.small.length : 0));
</script>

{#if parts.large}
  <View style={{ gap: 6, alignSelf: "start", maxWidth: width }}>
    <View style={{ direction: "row", gap }}>
      <OpenImage src={str(parts.large, "src") ?? ""} alt={str(parts.large, "alt")} width={largeWidth} height={largeHeight} />
      {#if !narrow && parts.small.length > 0}
        <View style={{ gap }}>
          {#each parts.small as image}
            <OpenImage src={str(image, "src") ?? ""} alt={str(image, "alt")} width={smallWidth} height={smallHeight} />
          {/each}
        </View>
      {/if}
    </View>
    <Text style={{ color: p.muted, fontSize: 12 }}>
      {pictureName(str(parts.large, "src") ?? "", str(parts.large, "alt"))}{hidden > 0 ? `  +${hidden} more` : ""}
    </Text>
  </View>
{/if}
