<!--
  The column at the right of an agent pane, shown while there is a plan or a changed file to show
  and the pane is wide enough: the plan above, the files below. A diff opened from the files takes
  the whole column.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import Files from "./Files.svelte";
  import type { FilesModel } from "./filesModel";
  import { palette } from "./palette";
  import Plan from "./Plan.svelte";

  let { chat, files, branch }: { chat: ChatSession; files: FilesModel; branch: string | null } = $props();

  const p = palette;

  const diffOpen = $derived(files.diff() !== null);
</script>

<View
  style={{
    width: 380,
    shrink: 0,
    gap: p.space.l,
    padding: p.space.m,
    background: p.surface,
    borderLeftWidth: 1,
    borderColor: p.border,
  }}
>
  {#if !diffOpen}
    <Plan plans={chat.plans()} />
  {/if}
  <Files {files} {branch} />
</View>
