<!--
  A tree of changed files: folders that open and close, each file with its icon from the active
  icon set, its name and git letter in the change's colour, as the explorer draws them. Folders
  start open, and a folder that appears later opens too. Pressing a file calls `onopen`; the
  consumer may draw a heading row for section nodes and buttons at the end of a hovered file row.
-->
<script lang="ts" generics="Item">
  import { Text, Tree, View, type PointerEvent, type Style, type TreeRow } from "@neoworks/svelte-gpui/ui";
  import { untrack, type Snippet } from "svelte";
  import { colors, fontSize } from "../theme/tokens";
  import { changeColor } from "./changeColors";
  import { folderKeysOf, lastSegment, type ChangeTreeNode } from "./changeTree";
  import FileIconView from "./FileIconView.svelte";
  import { iconForFile, iconForFolder, type FileIcon, type IconSet } from "./fileIcons";
  import { CHANGE_LETTERS } from "./model";

  interface Props {
    roots: ChangeTreeNode<Item>[];
    iconSet: IconSet;
    /** A file's row was pressed. */
    onopen: (node: ChangeTreeNode<Item>) => void;
    /** The key of the highlighted row. */
    selected?: string | number | undefined;
    rowHeight?: number;
    /** Draws a section node's row, to the right of its arrow. */
    header?: Snippet<[ChangeTreeNode<Item>, TreeRow]>;
    /** Draws at the end of a file's row; `hovered` is whether the pointer is on the row. */
    trailing?: Snippet<[ChangeTreeNode<Item>, boolean]>;
    style?: Style;
  }

  let { roots, iconSet, onopen, selected = $bindable(), rowHeight = 24, header, trailing, style }: Props = $props();

  /** Every folder key the tree has had, so one the user closed stays closed while one that is new opens. */
  const knownFolders = new Set<string>();
  let expanded = $state<Set<string | number>>(new Set());
  let hoveredKey = $state<string | null>(null);

  // A folder seen for the first time opens.
  $effect(() => {
    const folders = folderKeysOf(roots);
    untrack(() => {
      const fresh = folders.filter((key) => !knownFolders.has(key));
      if (fresh.length === 0) {
        return;
      }
      for (const key of fresh) {
        knownFolders.add(key);
      }
      expanded = new Set([...expanded, ...fresh]);
    });
  });

  /** The colour of a row's name: its change's colour, else the quiet text colour. */
  function nameColor(node: ChangeTreeNode<Item>): string {
    if (node.change === undefined) {
      return colors.muted;
    }
    return changeColor(node.change);
  }

  /** The icon a row gets from the active set. */
  function iconOf(node: ChangeTreeNode<Item>, expandedNow: boolean): FileIcon {
    if (node.isDir) {
      return iconForFolder(iconSet, lastSegment(node.name), expandedNow);
    }
    return iconForFile(iconSet, node.name);
  }

  /** A press on a row: opens or closes a folder, opens a file. */
  function pressRow(event: PointerEvent, node: ChangeTreeNode<Item>, row: TreeRow): void {
    if (event.button !== 0) {
      return;
    }
    row.select();
    if (node.isDir) {
      row.toggle();
      return;
    }
    onopen(node);
  }

  /** Tracks which file row the pointer is on. */
  function trackHover(key: string, hovered: boolean): void {
    if (hovered) {
      hoveredKey = key;
      return;
    }
    if (hoveredKey === key) {
      hoveredKey = null;
    }
  }
</script>

<Tree
  items={roots}
  key={(node: ChangeTreeNode<Item>) => node.key}
  childrenOf={(node: ChangeTreeNode<Item>) => node.children}
  isBranch={(node: ChangeTreeNode<Item>) => node.isDir}
  bind:expanded
  bind:selected
  {rowHeight}
  indent={12}
  onactivate={(node: ChangeTreeNode<Item>) => {
    if (!node.isDir) {
      onopen(node);
    }
  }}
  style={{ flex: 1, ...style }}
>
  {#snippet row(node: ChangeTreeNode<Item>, info: TreeRow)}
    {#if node.section && header !== undefined}
      {@render header(node, info)}
    {:else}
      <!-- The tree puts a row in a column of no height of its own: `flex: 1` or `"full"` would leave nothing to press. -->
      <View
        style={{ direction: "row", align: "center", gap: 6, minWidth: 0, height: rowHeight, fontSize: fontSize.xs }}
        onhover={(hovered: boolean) => trackHover(node.key, hovered)}
        onpress={(event: PointerEvent) => pressRow(event, node, info)}
      >
        <FileIconView icon={iconOf(node, info.expanded)} size={14} fallbackColor={nameColor(node)} />
        <Text style={{ flex: 1, minWidth: 0, truncate: true, color: nameColor(node) }}>{node.name}</Text>
        {#if trailing !== undefined && !node.isDir}
          {@render trailing(node, hoveredKey === node.key)}
        {/if}
        {#if node.change !== undefined && !node.isDir}
          <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: changeColor(node.change) }}>{CHANGE_LETTERS[node.change]}</Text>
        {/if}
      </View>
    {/if}
  {/snippet}
</Tree>
