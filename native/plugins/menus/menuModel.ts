// The app menu as data, and the pure steps from that data to the rows a menu draws.
// Ported from `lib/menu.svelte.ts`: the registry (reactive lists, command lookup) stays with
// the kernel, what is left is the shapes and the ordering rules.

import type { MenuItem as MenuRow } from "@neoworks/svelte-gpui/ui";

export interface TopMenu {
  id: string;
  label: string;
  order: number;
}

export interface MenuBarItem {
  id: string;
  menuId: string;
  label: string;
  // Items are grouped; a separator is drawn between groups.
  group?: string;
  // Heading shown above the group, taken from its first item that sets one.
  groupLabel?: string;
  // Hover text, e.g. the full path behind a short label.
  detail?: string;
  order?: number;
  // Display-only hint (real keys live in the keymap).
  accelerator?: string;
  // Hidden while this returns false.
  when?: () => boolean;
  // The command this item runs; whoever wires the bar up resolves it.
  commandId?: string;
}

/** Orders items by group, then by their own order. */
function compareItems(first: MenuBarItem, second: MenuBarItem): number {
  const groupOrder = (first.group ?? "").localeCompare(second.group ?? "");
  if (groupOrder !== 0) {
    return groupOrder;
  }
  return (first.order ?? 0) - (second.order ?? 0);
}

/** The visible items of one top-level menu, sorted by group then order. */
export function itemsForMenu(items: readonly MenuBarItem[], menuId: string): MenuBarItem[] {
  return items
    .filter((item) => item.menuId === menuId)
    .filter((item) => item.when === undefined || item.when())
    .sort(compareItems);
}

/** The first heading any item of the group declares, or undefined. */
function groupHeading(items: readonly MenuBarItem[], group: string): string | undefined {
  const labelled = items.find((item) => (item.group ?? "") === group && item.groupLabel);
  return labelled?.groupLabel;
}

/** What the caller knows about items that the data does not: which cannot run, and their real keys. */
export interface RowOptions {
  /** Items for which this returns true are drawn greyed out and cannot be chosen. */
  isDisabled?: (item: MenuBarItem) => boolean;
  /**
   * The shortcut to show for an item: the empty string says it has none, which hides the item's
   * own `accelerator`, and undefined leaves that hint showing.
   */
  acceleratorFor?: (item: MenuBarItem) => string | undefined;
}

/** The shortcut an item shows, preferring the caller's over the one in the data. */
function shortcutOf(item: MenuBarItem, options: RowOptions): string | undefined {
  if (options.acceleratorFor) {
    const live = options.acceleratorFor(item);
    if (live === "") {
      return undefined;
    }
    if (live !== undefined) {
      return live;
    }
  }
  return item.accelerator;
}

/** Whether the caller says this item cannot run now. */
function disabledOf(item: MenuBarItem, options: RowOptions): boolean {
  if (!options.isDisabled) {
    return false;
  }
  return options.isDisabled(item);
}

/**
 * The rows a `Menu` draws for sorted items: a separator where the group changes, and the
 * group's heading as a disabled row when it has one. `onselect` is called with the chosen item.
 */
export function menuRows(
  items: readonly MenuBarItem[],
  onselect: (item: MenuBarItem) => void,
  options: RowOptions = {},
): MenuRow[] {
  const rows: MenuRow[] = [];
  items.forEach((item, index) => {
    const group = item.group ?? "";
    const startsGroup = index === 0 || (items[index - 1].group ?? "") !== group;
    if (startsGroup && index > 0) {
      rows.push({ separator: true });
    }
    const heading = startsGroup ? groupHeading(items, group) : undefined;
    if (heading !== undefined) {
      rows.push({ label: heading.toUpperCase(), disabled: true });
    }
    rows.push({
      label: item.label,
      shortcut: shortcutOf(item, options),
      disabled: disabledOf(item, options),
      onselect: () => onselect(item),
      value: item.id,
    });
  });
  return rows;
}
