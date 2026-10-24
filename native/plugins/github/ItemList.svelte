<!--
  The rows of a list of issues or pull requests: a state icon, the title with its labels, and under
  it who opened it, when it last changed and how many comments it has. Pressing a row shows it.
-->
<script lang="ts">
  import { Icon, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import chatCircle from "@phosphor-icons/core/regular/chat-circle.svg";
  import checkCircle from "@phosphor-icons/core/regular/check-circle.svg";
  import circleDashed from "@phosphor-icons/core/regular/circle-dashed.svg";
  import radioButton from "@phosphor-icons/core/regular/radio-button.svg";
  import gitMerge from "@phosphor-icons/core/regular/git-merge.svg";
  import gitPullRequest from "@phosphor-icons/core/regular/git-pull-request.svg";
  import { colors, fontSize } from "../theme/tokens";
  import LabelPill from "./LabelPill.svelte";
  import type { ItemSummary } from "./model";
  import { agoOf } from "./present";
  import type { ListLoad } from "./service";

  interface Props {
    list: ListLoad;
    kind: "issue" | "pull";
    onopen: (item: ItemSummary) => void;
  }

  let { list, kind, onopen }: Props = $props();

  const ROW_HEIGHT = 54;
  const now = Date.now();

  /** The icon at the start of a row, in the state's colour. */
  function iconOf(item: ItemSummary): string {
    if (item.state === "merged") {
      return gitMerge;
    }
    if (item.state === "draft") {
      return circleDashed;
    }
    if (item.kind === "pull") {
      return gitPullRequest;
    }
    if (item.state === "closed") {
      return checkCircle;
    }
    return radioButton;
  }

  /** The colour of a state. */
  function toneOf(item: ItemSummary): string {
    if (item.state === "open") {
      return colors.green;
    }
    if (item.state === "closed") {
      return colors.red;
    }
    if (item.state === "merged") {
      return colors.accent;
    }
    return colors.dim;
  }

  /** The line under a title. */
  function detailOf(item: ItemSummary): string {
    const ago = agoOf(item.updatedAt, now);
    return `#${item.number} by ${item.author}, updated ${ago}`;
  }

  /** The words for an empty list. */
  function emptyText(): string {
    if (kind === "pull") {
      return "No pull requests match.";
    }
    return "No issues match.";
  }
</script>

{#if list.status === "error"}
  <View style={{ padding: 16, gap: 8 }}>
    <Text style={{ fontSize: fontSize.sm, color: colors.red }}>{list.message}</Text>
  </View>
{:else if list.status === "loading" && list.items.length === 0}
  <View style={{ padding: 16 }}>
    <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
  </View>
{:else if list.items.length === 0}
  <View style={{ padding: 16 }}>
    <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{emptyText()}</Text>
  </View>
{:else}
  <List items={list.items} rowHeight={ROW_HEIGHT} key={(item: ItemSummary) => `${item.kind}${item.number}`} style={{ flex: 1, minHeight: 0 }}>
    {#snippet row(item: ItemSummary)}
      <View
        style={{ direction: "row", gap: 10, height: ROW_HEIGHT, paddingX: 12, paddingY: 8, cursor: "pointer", borderBottomWidth: 1, borderColor: colors.lineFaint }}
        hover={{ background: colors.hover }}
        onpress={() => onopen(item)}
      >
        <View style={{ paddingTop: 2, color: toneOf(item), shrink: 0 }}>
          <Icon svg={iconOf(item)} size={16} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ direction: "row", align: "center", gap: 6 }}>
            <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.sm, color: colors.text }}>{item.title}</Text>
            {#each item.labels.slice(0, 3) as label (label.name)}
              <LabelPill name={label.name} color={label.color} />
            {/each}
          </View>
          <Text style={{ truncate: true, minWidth: 0, fontSize: fontSize.xxs, color: colors.dim }}>{detailOf(item)}</Text>
        </View>
        {#if item.comments > 0}
          <View style={{ direction: "row", align: "center", gap: 3, shrink: 0, color: colors.dim }}>
            <Icon svg={chatCircle} size={13} />
            <Text style={{ fontSize: fontSize.xxs }}>{item.comments}</Text>
          </View>
        {/if}
      </View>
    {/snippet}
  </List>
  {#if list.total > list.items.length}
    <Text style={{ shrink: 0, paddingX: 12, paddingY: 6, fontSize: fontSize.xxs, color: colors.dim, borderTopWidth: 1, borderColor: colors.lineFaint }}>
      Showing the {list.items.length} most recently updated of {list.total}. Search to narrow them.
    </Text>
  {/if}
{/if}
