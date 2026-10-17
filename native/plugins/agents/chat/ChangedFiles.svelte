<script lang="ts">
  // What a folded turn changed, one row per file: the calls are detail and the files are the
  // outcome. Pressing a file shows it in the editor.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { palette } from "../palette";
  import { shortDirectory } from "./callRow";
  import { baseName } from "./components";
  import { useChat } from "./context";
  import ItemFrame from "./ItemFrame.svelte";
  import type { ChangedFile } from "./turns";

  let { files }: { files: readonly ChangedFile[] } = $props();

  const p = palette;
  const chat = useChat();
</script>

<ItemFrame>
  <View style={{ paddingX: p.space.l }}>
    {#each files as file (file.path)}
      <View
        onpress={() => chat.openFile(file.path)}
        hover={{ background: p.surface }}
        style={{ direction: "row", align: "center", gap: p.space.m, paddingLeft: 20, cursor: "pointer", radius: 4 }}
      >
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, shrink: 0 }}>{baseName(file.path)}</Text>
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, flex: 1, minWidth: 0, truncate: true }}>{shortDirectory(file.path) ?? ""}</Text>
        {#if file.created}
          <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, shrink: 0 }}>new</Text>
        {/if}
        {#if file.added > 0}
          <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.success, shrink: 0 }}>+{file.added}</Text>
        {/if}
        {#if file.removed > 0}
          <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.danger, shrink: 0 }}>−{file.removed}</Text>
        {/if}
      </View>
    {/each}
  </View>
</ItemFrame>
