<!--
  One issue or pull request: its title and state, who opened it, its labels, its body as markdown,
  for a pull request the branches, checks, reviews and files, and then the comments.
-->
<script lang="ts">
  import { Button, Icon, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import arrowSquareOut from "@phosphor-icons/core/regular/arrow-square-out.svg";
  import type { FileIconSource } from "../explorer/fileIcons";
  import { colors, fontSize, radius } from "../theme/tokens";
  import LabelPill from "./LabelPill.svelte";
  import Markdown from "./Markdown.svelte";
  import type { PullDetail, PullFile } from "./model";
  import { agoOf, commentCount } from "./present";
  import PullSections from "./PullSections.svelte";
  import type { ItemLoad } from "./service";
  import StateTag from "./StateTag.svelte";

  interface Props {
    item: ItemLoad;
    icons: FileIconSource;
    onbrowser: () => void;
    onfile: (file: PullFile) => void;
  }

  let { item, icons, onbrowser, onfile }: Props = $props();

  const now = Date.now();
  const detail = $derived(item.detail);
  const pull = $derived.by(() => {
    if (detail !== null && detail.kind === "pull") {
      return detail as PullDetail;
    }
    return null;
  });
</script>

{#if item.status === "error"}
  <View style={{ padding: 16 }}>
    <Text style={{ fontSize: fontSize.sm, color: colors.red }}>{item.message}</Text>
  </View>
{:else if detail === null}
  <View style={{ padding: 16 }}>
    <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
  </View>
{:else}
  <Scroll style={{ flex: 1, minHeight: 0 }}>
    <View style={{ gap: 14, padding: 16 }}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "bold", color: colors.text }}>
          {detail.title}
          <Text style={{ color: colors.dim, fontWeight: "normal" }}> #{detail.number}</Text>
        </Text>
        <View style={{ direction: "row", align: "center", gap: 8 }}>
          <StateTag state={detail.state} kind={detail.kind} />
          <Button
            style={{ height: 22, paddingX: 8, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xs }}
            hover={{ background: colors.hover, color: colors.text }}
            onpress={onbrowser}
          >
            <Icon svg={arrowSquareOut} size={12} />
            <Text>Open on GitHub</Text>
          </Button>
        </View>
        <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>
          {detail.author} opened this {agoOf(detail.createdAt, now)}, {commentCount(detail.comments)}
        </Text>
        {#if pull !== null}
          <Text style={{ fontFamily: "mono", fontSize: fontSize.xs, color: colors.muted }}>{pull.headBranch} into {pull.baseBranch}</Text>
          <View style={{ direction: "row", align: "center", gap: 8 }}>
            <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xs, color: colors.green }}>+{pull.additions}</Text>
            <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xs, color: colors.red }}>-{pull.deletions}</Text>
            <Text style={{ shrink: 0, fontSize: fontSize.xs, color: colors.dim }}>{pull.changedFiles} files</Text>
          </View>
        {/if}
        {#if detail.labels.length > 0 || detail.assignees.length > 0}
          <View style={{ direction: "row", align: "center", gap: 6, wrap: true }}>
            {#each detail.labels as label (label.name)}
              <LabelPill name={label.name} color={label.color} />
            {/each}
            {#if detail.assignees.length > 0}
              <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Assigned to {detail.assignees.join(", ")}</Text>
            {/if}
          </View>
        {/if}
      </View>

      <View style={{ padding: 12, radius: radius.md, background: colors.raised, borderWidth: 1, borderColor: colors.lineFaint }}>
        <Markdown text={detail.body} />
      </View>

      {#if pull !== null}
        <PullSections checks={item.checks} reviews={item.reviews} files={item.files} loaded={item.extras !== "loading"} {icons} {onfile} />
      {/if}

      {#if item.extrasMessage !== ""}
        <Text style={{ fontSize: fontSize.xs, color: colors.red }}>{item.extrasMessage}</Text>
      {/if}

      <View style={{ gap: 10 }}>
        <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>Comments ({item.comments.length})</Text>
        {#if item.extras === "loading"}
          <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
        {/if}
        {#each item.comments as comment (comment.id)}
          <View style={{ gap: 6, padding: 12, radius: radius.md, borderWidth: 1, borderColor: colors.lineFaint }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>
              <Text style={{ color: colors.text, fontWeight: "bold" }}>{comment.author}</Text>
              commented {agoOf(comment.createdAt, now)}
            </Text>
            <Markdown text={comment.body} empty="" />
          </View>
        {/each}
      </View>
    </View>
  </Scroll>
{/if}
