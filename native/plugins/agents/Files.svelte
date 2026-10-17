<!--
  The files panel: what git says changed in the session's worktree, plus the files the agent and
  its guests touched, tagged by who. Pressing a file shows its diff in a diff pane.
  Ported from neoworks-harness apps/gui (plugins/files).
-->
<script lang="ts">
  import { Button, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import DiffView from "./chat/DiffView.svelte";
  import { glyphOfMark, type FileEntry, type Mark } from "./files";
  import type { FilesModel } from "./filesModel";
  import { palette } from "./palette";

  let { files, branch }: { files: FilesModel; branch: string | null } = $props();

  const p = palette;

  const entries = $derived(files.entries());
  const diff = $derived(files.diff());
  const error = $derived(files.error());

  /** The colour of a file's margin letter and name. */
  function colorOf(mark: Mark): string {
    switch (mark) {
      case "added":
        return p.success;
      case "deleted":
        return p.danger;
      case "modified":
      case "renamed":
        return p.accent;
      default:
        return p.muted;
    }
  }

  /** The name of a file, with where a renamed one came from. */
  function nameOf(entry: FileEntry): string {
    if (entry.orig === undefined) {
      return entry.rel;
    }
    return `${entry.orig} → ${entry.rel}`;
  }

  /** The who-changed-it note after a name, or nothing. */
  function tagsOf(entry: FileEntry): string {
    if (entry.tags.length === 0) {
      return "";
    }
    return ` (${entry.tags.join(", ")})`;
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
    </View>
    {#if error !== null}
      <Text style={{ color: p.danger }}>{error}</Text>
    {/if}
    <Scroll style={{ flex: 1, minHeight: 0 }}>
      <View>
        {#each entries as entry (entry.rel)}
          <View
            onpress={() => files.open(entry)}
            hover={{ background: p.surface }}
            style={{ direction: "row", gap: p.space.m, paddingY: 1, cursor: "pointer" }}
          >
            <Text style={{ width: 12, color: colorOf(entry.mark) }}>{glyphOfMark(entry.mark)}</Text>
            <Text style={{ flex: 1, minWidth: 0, truncate: true, color: colorOf(entry.mark) }}>{nameOf(entry)}{tagsOf(entry)}</Text>
          </View>
        {/each}
      </View>
    </Scroll>
  </View>
{/if}
