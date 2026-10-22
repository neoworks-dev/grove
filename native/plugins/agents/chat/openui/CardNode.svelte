<script lang="ts">
  // A rounded card on the surface colour: `tone` colours its outline and title, `sunk` is the fill
  // without the outline, `clear` neither (just the title above the children). A framed card that
  // starts with an Image wears it as a cover: edge to edge along its top, cropped to fill, without
  // the alt line (the title under it says what it is).
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { CARD_PADDING, coverHeight, insideCard } from "./layout";
  import Kids from "./Kids.svelte";
  import { outline, toneColor } from "./look";
  import OpenImage from "./OpenImage.svelte";
  import { nodes, str, tone as toneOf } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width, fill = false }: NodeProps = $props();
  const p = neouiPalette;

  const variant = $derived(str(node, "variant"));
  const tone = $derived(toneOf(node));
  const title = $derived(str(node, "title"));
  const framed = $derived(variant !== "clear");
  const border = $derived(variant === "sunk" || !framed ? 0 : 1);
  const inner = $derived(framed ? insideCard(width) : width);
  const children = $derived(nodes(node, "children"));
  const cover = $derived(framed && children[0]?.component === "Image" ? children[0] : undefined);
  const coverWidth = $derived(Math.max(0, width - border * 2));
  const corner = $derived(Math.max(0, p.radius.m - border));
</script>

<View
  style={{
    background: framed ? p.surface : undefined,
    radius: p.radius.m,
    borderWidth: border,
    borderColor: outline(p, tone),
    padding: framed ? CARD_PADDING : 0,
    gap: 10,
    grow: fill ? 1 : undefined,
  }}
>
  {#if cover}
    <!-- Out over the padding to the card's edges. In a box of its own size, which clips: the host
      draws a covering picture past its box. (A padded column under a picture instead was laid out
      taller than its children.) -->
    <View
      style={{
        width: coverWidth,
        height: coverHeight(coverWidth),
        marginTop: -CARD_PADDING,
        marginLeft: -CARD_PADDING,
        marginBottom: 4,
        overflow: "hidden",
        radius: [corner, corner, 0, 0],
      }}
    >
      <OpenImage
        src={str(cover, "src") ?? ""}
        alt={str(cover, "alt")}
        width={coverWidth}
        height={coverHeight(coverWidth)}
        radius={[corner, corner, 0, 0]}
        fit="cover"
      />
    </View>
  {/if}
  {#if title}
    <Text
      style={{
        fontSize: p.text.title,
        fontWeight: "semibold",
        color: tone === undefined ? p.fg : toneColor(tone, p),
      }}>{title}</Text
    >
  {/if}
  <Kids {children} {path} width={inner} skip={cover ? 1 : 0} />
</View>
