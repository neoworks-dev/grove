<!--
  What only a pull request has: how its checks stand, who reviewed it and what they decided, and
  the files it changes as the explorer's tree, each with its added and removed lines. Pressing a
  file opens it with the pull request's changes.
-->
<script lang="ts">
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import checkCircle from "@phosphor-icons/core/regular/check-circle.svg";
  import circleNotch from "@phosphor-icons/core/regular/circle-notch.svg";
  import minusCircle from "@phosphor-icons/core/regular/minus-circle.svg";
  import xCircle from "@phosphor-icons/core/regular/x-circle.svg";
  import ChangeTree from "../explorer/ChangeTree.svelte";
  import type { ChangeTreeNode } from "../explorer/changeTree";
  import type { FileIconSource } from "../explorer/fileIcons";
  import { colors, fontSize } from "../theme/tokens";
  import { checksSummary, type Check, type CheckState, type PullFile, type Review } from "./model";
  import { agoOf, checkCountWord, checkWord, reviewWord } from "./present";
  import { pullFileTree } from "./tree";

  interface Props {
    checks: Check[];
    reviews: Review[];
    files: PullFile[];
    /** Whether the checks, reviews and files have been read. */
    loaded: boolean;
    icons: FileIconSource;
    onfile: (file: PullFile) => void;
  }

  let { checks, reviews, files, loaded, icons, onfile }: Props = $props();

  const ROW_HEIGHT = 24;
  const MAX_TREE_HEIGHT = 360;
  const now = Date.now();

  const summary = $derived(checksSummary(checks));
  const tree = $derived(pullFileTree(files));
  const treeHeight = $derived(Math.min(treeRows(tree) * ROW_HEIGHT, MAX_TREE_HEIGHT));
  const decisions = $derived(reviews.filter((review) => review.state !== "commented" || review.body.trim() !== ""));

  /** How many rows a fully opened tree has. */
  function treeRows(nodes: ChangeTreeNode<PullFile>[]): number {
    let rows = 0;
    for (const node of nodes) {
      rows += 1 + treeRows(node.children);
    }
    return rows;
  }

  /** The colour of a check's state. */
  function toneOf(state: CheckState): string {
    if (state === "passing") {
      return colors.green;
    }
    if (state === "failing") {
      return colors.red;
    }
    if (state === "pending") {
      return colors.amber;
    }
    return colors.dim;
  }

  /** The icon of a check's state. */
  function iconOf(state: CheckState): string {
    if (state === "passing") {
      return checkCircle;
    }
    if (state === "failing") {
      return xCircle;
    }
    if (state === "pending") {
      return circleNotch;
    }
    return minusCircle;
  }

  /** The colour of a review's decision. */
  function reviewTone(state: string): string {
    if (state === "approved") {
      return colors.green;
    }
    if (state === "changes requested") {
      return colors.red;
    }
    return colors.muted;
  }

  /** A file's row was pressed. */
  function openFile(node: ChangeTreeNode<PullFile>): void {
    if (node.item !== undefined) {
      onfile(node.item);
    }
  }
</script>

<View style={{ gap: 14 }}>
  <View style={{ gap: 6 }}>
    <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>Checks</Text>
    {#if !loaded}
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
    {:else if summary === null}
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>No checks ran on this pull request.</Text>
    {:else}
      <Text style={{ fontSize: fontSize.xs, color: toneOf(summary) }}>{checkWord(summary)}: {checkCountWord(checks.length)}</Text>
      {#each checks as check (check.name)}
        <View style={{ direction: "row", align: "center", gap: 6, color: toneOf(check.state) }}>
          <Icon svg={iconOf(check.state)} size={14} />
          <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xs, color: colors.text }}>{check.name}</Text>
          <Text style={{ fontSize: fontSize.xxs }}>{checkWord(check.state)}</Text>
        </View>
      {/each}
    {/if}
  </View>

  <View style={{ gap: 6 }}>
    <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>Reviews</Text>
    {#if !loaded}
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
    {:else if decisions.length === 0}
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Nobody has reviewed this yet.</Text>
    {:else}
      {#each decisions as review (review.id)}
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fontSize.xs, color: colors.text }}>
            {review.author}
            <Text style={{ color: reviewTone(review.state) }}>{reviewWord(review.state)}</Text>
            <Text style={{ color: colors.dim }}> {agoOf(review.submittedAt, now)}</Text>
          </Text>
          {#if review.body.trim() !== ""}
            <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>{review.body}</Text>
          {/if}
        </View>
      {/each}
    {/if}
  </View>

  <View style={{ gap: 6 }}>
    <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>Files changed ({files.length})</Text>
    {#if !loaded}
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
    {:else if files.length > 0}
      <View style={{ height: treeHeight, radius: 6, borderWidth: 1, borderColor: colors.lineFaint, overflow: "hidden" }}>
        <ChangeTree roots={tree} iconSet={icons.iconSet()} rowHeight={ROW_HEIGHT} onopen={openFile}>
          {#snippet trailing(node: ChangeTreeNode<PullFile>)}
            {#if node.item !== undefined}
              <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.green }}>+{node.item.additions}</Text>
              <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.red }}>-{node.item.deletions}</Text>
            {/if}
          {/snippet}
        </ChangeTree>
      </View>
    {/if}
  </View>
</View>
