<!--
  The images attached to the draft, above the input: a thumbnail and the file name each, and a
  cross that takes one off. Ported from neo term's draw_attached (apps/term).
-->
<script lang="ts">
  import { Button, Image, Text, View } from "@neoworks/svelte-gpui/ui";
  import { fileNameOf, type Attachment } from "./attachments";
  import { palette } from "./palette";

  interface Props {
    attachments: readonly Attachment[];
    /** The cross of an image was pressed. */
    ondetach: (id: number) => void;
  }

  let { attachments, ondetach }: Props = $props();

  const p = palette;
  const THUMBNAIL = 44;
</script>

<View style={{ direction: "row", wrap: true, gap: p.space.m, paddingX: p.space.m }}>
  {#each attachments as attachment (attachment.id)}
    <View
      style={{
        direction: "row",
        align: "center",
        gap: p.space.s,
        padding: p.space.s,
        radius: 6,
        borderWidth: 1,
        borderColor: p.elevatedBorder,
        background: p.elevated,
      }}
    >
      {#if attachment.source !== undefined}
        <Image src={attachment.source} fit="cover" style={{ width: THUMBNAIL, height: THUMBNAIL, radius: 4 }} />
      {:else}
        <View style={{ width: THUMBNAIL, height: THUMBNAIL, radius: 4, background: p.band }} />
      {/if}
      <Text style={{ maxWidth: 160, truncate: true, fontSize: p.text.code }}>{fileNameOf(attachment.path)}</Text>
      <Button onpress={() => ondetach(attachment.id)} style={{ paddingX: p.space.s, radius: 4, color: p.muted }} hover={{ background: p.band }}>
        <Text>×</Text>
      </Button>
    </View>
  {/each}
</View>
