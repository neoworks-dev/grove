<!--
  The files panel: the files the session's agent and its guests changed, as a folder tree with the
  explorer's icons and git colours. Pressing a file shows its diff in a diff pane.
  Ported from neoworks-harness apps/gui (plugins/files).
-->
<script lang="ts">
  import { Button, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import Slot from "../../kernel/slots/Slot.svelte";
  import ChangeTree from "../explorer/ChangeTree.svelte";
  import { buildChangeTree, type ChangeTreeNode } from "../explorer/changeTree";
  import type { FileIconSource } from "../explorer/fileIcons";
  import DiffView from "./chat/DiffView.svelte";
  import { changeOfMark, type FileEntry } from "./files";
  import type { FilesModel } from "./filesModel";
  import { palette } from "./palette";

  let { files, branch, icons }: { files: FilesModel; branch: string | null; icons: FileIconSource } = $props();

  const p = palette;

  const worktreePath = $derived.by(() => {
    const worktree = files.worktree();
    if (worktree === null) {
      return null;
    }
    return worktree.path;
  });
  const entries = $derived(files.entries());
  const diff = $derived(files.diff());
  const error = $derived(files.error());
  const roots = $derived(buildChangeTree(entries.map((entry) => ({ path: entry.rel, change: changeOfMark(entry.mark), item: entry }))));

  /** The guests that changed a file, when it was not only the session's own agent. */
  function guestsOf(entry: FileEntry): string {
    const guests = entry.tags.filter((tag) => tag !== "agent");
    return guests.join(", ");
  }

  /** A file's row was pressed: its diff opens in a diff pane. */
  function openFile(node: ChangeTreeNode<FileEntry>): void {
    if (node.item !== undefined) {
      files.open(node.item);
    }
  }
</script>

{#if diff !== null}
  <View style={{ gap: p.space.s, minHeight: 0, flex: 1 }}>
    <View style={{ direction: "row", align: "center", gap: p.space.s }}>
      <Button
        onpress={() => files.closeDiff()}
        style={{ paddingX: p.space.s, radius: 4, color: p.accent }}
        hover={{ background: p.band }}
      >
        <Text>◂ files</Text>
      </Button>
    </View>
    <Scroll style={{ flex: 1, minHeight: 0 }}>
      <DiffView diff={{ type: "diff", path: diff.path, lines: [...diff.lines] }} />
    </Scroll>
  </View>
{:else}
  <View style={{ gap: p.space.s, minHeight: 0, flex: 1 }}>
    <View style={{ direction: "row", gap: p.space.s }}>
      <Text style={{ color: p.muted, fontWeight: "bold" }}>Files</Text>
      {#if branch !== null}
        <Text style={{ color: p.muted, flex: 1, minWidth: 0, truncate: true }}>· {branch}</Text>
      {/if}
      <Slot name="agents.files.review" props={{ worktreePath }} />
    </View>
    {#if error !== null}
      <Text style={{ color: p.danger }}>{error}</Text>
    {/if}
    {#if roots.length === 0}
      <Text style={{ color: p.muted }}>The agent has not changed any files yet.</Text>
    {:else}
      <ChangeTree {roots} iconSet={icons.iconSet()} onopen={openFile}>
        {#snippet trailing(node: ChangeTreeNode<FileEntry>)}
          {#if node.item !== undefined && guestsOf(node.item) !== ""}
            <Text style={{ shrink: 0, color: p.muted }}>{guestsOf(node.item)}</Text>
          {/if}
        {/snippet}
      </ChangeTree>
    {/if}
  </View>
{/if}
