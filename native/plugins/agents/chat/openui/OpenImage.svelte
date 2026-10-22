<script lang="ts">
  // A picture of an OpenUI doc in a box of a fixed size (the list measures a row once: a picture
  // that changed it after loading would overlap the next). A web image is downloaded by the daemon
  // into its asset store and read from there; until then, and when that fails, the box says so.
  import { Image, Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useChat } from "../context";
  import { downloaded, pictureName, sourceOf } from "./image";

  interface Props {
    src: string;
    alt?: string;
    width: number;
    height: number;
    /** Corner radius, or each corner's; the box's own when absent. */
    radius?: number | [number, number, number, number];
    /** `cover` fills the box and crops, `contain` (the default) shows all of the picture. */
    fit?: "contain" | "cover";
  }

  let { src, alt, width, height, radius, fit = "contain" }: Props = $props();
  const p = neouiPalette;
  const chat = useChat();

  let url = $state<string>();
  let failure = $state<string>();
  const name = $derived(pictureName(src, alt));

  // What the effect reads is only the source: the state it sets is written, never read, here.
  $effect(() => {
    const source = sourceOf(src, chat.directory());
    url = undefined;
    failure = undefined;
    if (source.kind === "web") {
      let current = true;
      downloaded(source.url, (address) => chat.fetchAsset(address)).then(
        (handle) => {
          if (!current) return;
          const found = chat.assetSource(handle);
          if (found === handle) failure = "the daemon is not reachable";
          else url = found;
        },
        (error: unknown) => {
          if (current) failure = error instanceof Error ? error.message : String(error);
        },
      );
      return () => {
        current = false;
      };
    }
    if (source.kind === "asset") {
      const found = chat.assetSource(source.handle);
      if (found === source.handle) failure = "the asset is not reachable";
      else url = found;
    } else if (source.kind === "file") {
      url = source.path;
    } else {
      url = source.url;
    }
    return undefined;
  });
</script>

{#if url !== undefined && failure === undefined}
  <Image
    src={url}
    {fit}
    style={{ width, height, radius: radius ?? p.radius.s, background: p.raised }}
    onerror={() => (failure = "could not be loaded")}
  />
{:else}
  <View style={{ width, height, align: "center", justify: "center", paddingX: p.space.m, background: p.raised, radius: radius ?? p.radius.s }}>
    <Text style={{ color: p.muted, fontSize: 12, textAlign: "center", maxLines: 3 }}>
      {failure === undefined ? `[image ${name}] loading image…` : `[image ${name}] ${failure}`}
    </Text>
  </View>
{/if}
