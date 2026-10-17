<script lang="ts">
  // Code or command output: mono on the surface colour, long lines scroll sideways. Capped, since
  // one text of many thousand lines makes every frame slow.
  import { Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import { lineHeightOf } from "./components";
  import { clip } from "./diff";
  import { palette } from "../palette";

  interface Props {
    code: string;
    /** Lines to show before "… N more lines"; all (up to a cap) when absent. */
    limit?: number;
  }

  /** The most lines drawn, however much the result holds. */
  const CAP = 400;

  let { code, limit }: Props = $props();
  const p = palette;

  const lines = $derived(code.replace(/\n+$/, "").split("\n"));
  const clipped = $derived(clip(lines, limit ?? CAP));
  const text = $derived(clipped.shown.join("\n"));
</script>

<View style={{ background: p.surface, radius: 6 }}>
  <Scroll horizontal>
    <View style={{ padding: [p.space.m, p.space.l] }}>
      <Text
        pre
        style={{
          fontFamily: "mono",
          fontSize: p.text.code,
          lineHeight: lineHeightOf(p.text.code),
          nowrap: true,
        }}>{text}</Text>
    </View>
  </Scroll>
  {#if clipped.hidden > 0}
    <View style={{ paddingX: p.space.l, paddingBottom: p.space.m }}>
      <Text style={{ color: p.muted }}>… {clipped.hidden} more lines</Text>
    </View>
  {/if}
</View>
