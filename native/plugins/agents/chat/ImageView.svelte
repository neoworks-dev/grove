<script lang="ts">
  // A picture from a path, a data: URL, a URL or the daemon's asset store, in a box of a fixed
  // size (see Component.svelte for why it is fixed). When it can't be loaded the box says so.
  import { Image, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ImageComponent } from "@suite/protocol/types";
  import { baseName, oneLine } from "./components";
  import { useChat } from "./context";
  import { palette } from "../palette";

  interface Props {
    image: ImageComponent;
    width: number;
    height: number;
  }

  let { image, width, height }: Props = $props();
  const p = palette;
  const session = useChat();

  let failed = $state(false);
  // A new source gets a new chance.
  $effect(() => {
    void image.src;
    failed = false;
  });

  const name = $derived(image.alt ? oneLine(image.alt) : baseName(image.src));
</script>

<View style={{ gap: p.space.s, alignSelf: "start" }}>
  {#if failed}
    <View style={{ width, height: p.space.l * 2, justify: "center", paddingX: p.space.m, background: p.surface, radius: 6 }}>
      <Text style={{ color: p.muted, truncate: true }}>[image {name}] could not be loaded</Text>
    </View>
  {:else}
    <Image
      src={session.assetSource(image.src)}
      fit="contain"
      style={{ width, height, radius: 6 }}
      onerror={() => (failed = true)}
    />
  {/if}
  {#if image.caption}
    <Text style={{ color: p.muted }}>{image.caption}</Text>
  {/if}
</View>
