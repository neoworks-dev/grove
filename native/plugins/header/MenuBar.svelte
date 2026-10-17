<!--
  The header's app menu (File, Edit, …). Menus and their items are data; choosing an item calls
  `onrun`, and the caller decides what that means (run its command). While one menu is open,
  moving onto another top-level label switches to it, as a native menu bar does.
-->
<script lang="ts">
  import { Button, Menu, Popover, Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, menuItemStyle, overlayPanel, radius } from "../theme/tokens";
  import { itemsForMenu, menuRows, type MenuBarItem, type RowOptions, type TopMenu } from "../menus/menuModel";

  interface Props {
    menus: TopMenu[];
    items: MenuBarItem[];
    /** An item was chosen. */
    onrun: (item: MenuBarItem) => void;
    /** Items for which this returns true are greyed out and cannot be chosen. */
    isDisabled?: RowOptions["isDisabled"];
    /** The shortcut to show for an item, when it is not the one in its data. */
    acceleratorFor?: RowOptions["acceleratorFor"];
  }

  let { menus, items, onrun, isDisabled, acceleratorFor }: Props = $props();

  let openMenuId = $state<string | null>(null);

  const sortedMenus = $derived([...menus].sort((first, second) => first.order - second.order));

  /** Opens `menuId` when another menu is already open, the menu bar's hover-to-switch. */
  function switchTo(menuId: string): void {
    if (openMenuId === null || openMenuId === menuId) {
      return;
    }
    openMenuId = menuId;
  }

  /** Closes the open menu and runs the chosen item. */
  function choose(item: MenuBarItem): void {
    openMenuId = null;
    onrun(item);
  }

  /** Opens or closes one menu through the popover's `bind:open`. */
  function setOpen(menuId: string, open: boolean): void {
    if (open) {
      openMenuId = menuId;
      return;
    }
    if (openMenuId === menuId) {
      openMenuId = null;
    }
  }
</script>

<View style={{ direction: "row", align: "center" }}>
  {#each sortedMenus as top (top.id)}
    {@const open = openMenuId === top.id}
    <Popover
      bind:open={() => open, (value) => setOpen(top.id, value)}
      side="bottom"
      align="start"
      offset={4}
      focusPanel={false}
      style={overlayPanel}
    >
      {#snippet trigger({ toggle })}
        <Button
          style={{
            paddingX: 8,
            paddingY: 4,
            radius: radius.md,
            fontSize: fontSize.xs,
            color: open ? colors.text : colors.dim,
            background: open ? colors.surface : "transparent",
          }}
          hover={{ color: colors.text }}
          onpress={toggle}
          onhover={(hovered) => hovered && switchTo(top.id)}
        >
          <Text>{top.label}</Text>
        </Button>
      {/snippet}
      {#snippet children({ close })}
        <Menu
          items={menuRows(itemsForMenu(items, top.id), choose, { isDisabled, acceleratorFor })}
          width={224}
          onclose={() => close("select")}
          style={{ background: "transparent" }}
          itemStyle={menuItemStyle()}
        />
      {/snippet}
    </Popover>
  {/each}
</View>
