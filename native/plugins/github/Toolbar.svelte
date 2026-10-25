<!--
  The top of a GitHub pane. Over a list: the Issues and Pull requests tabs, the repository, a
  reload button, and under them the Open, Closed and Mine filters beside a box that searches with
  GitHub's own syntax on Enter, or jumps to an item when what was typed is a number, `owner/name#12`
  or an address. Over an item: a way back, the number and the buttons for the browser and reload.
-->
<script lang="ts">
  import { Button, Icon, Input, Text, View } from "@neoworks/svelte-gpui/ui";
  import arrowClockwise from "@phosphor-icons/core/regular/arrow-clockwise.svg";
  import arrowLeft from "@phosphor-icons/core/regular/arrow-left.svg";
  import arrowSquareOut from "@phosphor-icons/core/regular/arrow-square-out.svg";
  import magnifyingGlass from "@phosphor-icons/core/regular/magnifying-glass.svg";
  import { untrack } from "svelte";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { ItemKind, ListFilter } from "./model";
  import type { GithubView } from "./service";

  interface Props {
    view: GithubView;
    /** Whether the box was asked to take the keyboard. */
    focusRequested: boolean;
    /** The box has taken the keyboard. */
    onfocused: () => void;
    onkind: (kind: ItemKind) => void;
    onfilter: (filter: ListFilter) => void;
    /** What was typed and submitted: the pane decides whether it is a search or a jump. */
    onsubmit: (text: string) => void;
    onback: () => void;
    onreload: () => void;
    onbrowser: () => void;
  }

  let { view, focusRequested, onfocused, onkind, onfilter, onsubmit, onback, onreload, onbrowser }: Props = $props();

  let text = $state("");
  let field: Input | undefined = $state();

  // A primitive, so the effect below runs when the search changes and not each time the view is read again.
  const searched = $derived(view.place.search);

  // The box shows the search the list was last asked for, and follows a pane restored with one.
  $effect(() => {
    const asked = searched;
    untrack(() => {
      text = asked;
    });
  });

  // A command asks for the box.
  $effect(() => {
    if (focusRequested && field !== undefined) {
      untrack(() => {
        field?.focus();
        onfocused();
      });
    }
  });

  const repoName = $derived.by(() => {
    if (view.repo === null) {
      return "";
    }
    return view.repo;
  });
  const itemNoun = $derived.by(() => {
    if (view.place.item !== null && view.place.item.kind === "pull") {
      return "Pull request";
    }
    return "Issue";
  });

  const iconButton = { size: 24, align: "center", justify: "center", radius: radius.sm, shrink: 0, color: colors.dim } as const;

  /** The style of a tab or a filter chip, lit when it is the one in force. */
  function chip(active: boolean) {
    const base = { height: 24, paddingX: 10, align: "center", radius: radius.sm, fontSize: fontSize.xs } as const;
    if (active) {
      return { ...base, background: colors.elevated, color: colors.text };
    }
    return { ...base, background: "transparent", color: colors.muted };
  }
</script>

{#if view.place.view === "item" && view.place.item !== null}
  <View style={{ direction: "row", align: "center", gap: 6, height: 36, shrink: 0, paddingX: 8, borderBottomWidth: 1, borderColor: colors.lineFaint }}>
    <Button style={{ ...iconButton, width: 24 }} hover={{ background: colors.hover, color: colors.text }} onpress={onback}>
      <Icon svg={arrowLeft} size={14} />
    </Button>
    <Text style={{ shrink: 0, fontSize: fontSize.sm, color: colors.text }}>
      {itemNoun} #{view.place.item.number}
    </Text>
    <Text style={{ flex: 1, minWidth: 0, truncate: true, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>{repoName}</Text>
    <Button style={{ ...iconButton, width: 24 }} hover={{ background: colors.hover, color: colors.text }} onpress={onbrowser}>
      <Icon svg={arrowSquareOut} size={14} />
    </Button>
    <Button style={{ ...iconButton, width: 24 }} hover={{ background: colors.hover, color: colors.text }} onpress={onreload}>
      <Icon svg={arrowClockwise} size={14} />
    </Button>
  </View>
{:else}
  <View style={{ shrink: 0, gap: 6, paddingX: 8, paddingY: 6, borderBottomWidth: 1, borderColor: colors.lineFaint }}>
    <View style={{ direction: "row", align: "center", gap: 2 }}>
      <Button style={chip(view.place.listKind === "issue")} hover={{ background: colors.hover }} onpress={() => onkind("issue")}>
        <Text>Issues</Text>
      </Button>
      <Button style={chip(view.place.listKind === "pull")} hover={{ background: colors.hover }} onpress={() => onkind("pull")}>
        <Text>Pull requests</Text>
      </Button>
      <Text style={{ flex: 1, minWidth: 0, truncate: true, marginLeft: 8, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>
        {repoName}
      </Text>
      <Button style={{ ...iconButton, width: 24 }} hover={{ background: colors.hover, color: colors.text }} onpress={onreload}>
        <Icon svg={arrowClockwise} size={14} />
      </Button>
    </View>
    <View style={{ direction: "row", align: "center", gap: 6 }}>
      <Button style={chip(view.place.filter.state === "open")} hover={{ background: colors.hover }} onpress={() => onfilter({ ...view.place.filter, state: "open" })}>
        <Text>Open</Text>
      </Button>
      <Button style={chip(view.place.filter.state === "closed")} hover={{ background: colors.hover }} onpress={() => onfilter({ ...view.place.filter, state: "closed" })}>
        <Text>Closed</Text>
      </Button>
      <Button style={chip(view.place.filter.mine)} hover={{ background: colors.hover }} onpress={() => onfilter({ ...view.place.filter, mine: !view.place.filter.mine })}>
        <Text>Mine</Text>
      </Button>
      <View style={{ direction: "row", align: "center", gap: 6, flex: 1, minWidth: 0, height: 26, paddingX: 8, radius: radius.sm, background: colors.input, borderWidth: 1, borderColor: colors.line }}>
        <Icon svg={magnifyingGlass} size={13} color={colors.dim} />
        <Input
          bind:this={field}
          bind:value={text}
          placeholder="Search, or go to #123"
          onsubmit={(value: string) => onsubmit(value)}
          style={{ flex: 1, minWidth: 0, fontSize: fontSize.xs }}
        />
      </View>
    </View>
  </View>
{/if}
