<!--
  The column at the right of an agent pane, shown while there is a plan or a changed file to show
  and the pane is wide enough: the plan above, the files below. A diff opened from the files takes
  the whole column.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import type { FileIconSource } from "../explorer/fileIcons";
  import Files from "./Files.svelte";
  import type { FilesModel } from "./filesModel";
  import { palette } from "./palette";
  import Plan from "./Plan.svelte";
  import Todos from "./Todos.svelte";

  interface Props {
    chat: ChatSession;
    files: FilesModel;
    branch: string | null;
    icons: FileIconSource;
    /** The column takes all the room it has, instead of its own width. */
    fill?: boolean;
  }

  let { chat, files, branch, icons, fill = false }: Props = $props();

  const p = palette;

  const diffOpen = $derived(files.diff() !== null);
</script>

<View
  style={{
    width: fill ? undefined : 380,
    flex: fill ? 1 : undefined,
    shrink: 0,
    gap: p.space.l,
    padding: p.space.m,
    background: p.bg,
    borderLeftWidth: fill ? 0 : 1,
    borderColor: p.border,
  }}
>
  {#if !diffOpen}
    <Todos {chat} />
    <Plan plans={chat.plans()} />
  {/if}
  <Files {files} {branch} {icons} />
</View>
