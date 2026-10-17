import { describe, expect, it } from "bun:test";
import { CORE_MENUS, CORE_MENU_ITEMS } from "../plugins/header/coreMenu";
import { itemsForMenu, menuRows, type MenuBarItem } from "../plugins/header/menuModel";

const item = (id: string, group: string, order: number, extra: Partial<MenuBarItem> = {}): MenuBarItem => ({
  id,
  menuId: "m",
  label: id,
  group,
  order,
  ...extra,
});

describe("itemsForMenu", () => {
  it("sorts by group, then order, and keeps to one menu", () => {
    const items = [item("c", "2", 1), item("b", "1", 2), item("a", "1", 1), { ...item("x", "1", 0), menuId: "other" }];
    expect(itemsForMenu(items, "m").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("hides items whose condition is false", () => {
    const items = [item("a", "1", 1), item("b", "1", 2, { when: () => false })];
    expect(itemsForMenu(items, "m").map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("menuRows", () => {
  it("puts a separator where the group changes", () => {
    const rows = menuRows([item("a", "1", 1), item("b", "2", 1)], () => {});
    expect(rows.map((row) => row.separator === true)).toEqual([false, true, false]);
  });

  it("draws a group's heading as a disabled row", () => {
    const rows = menuRows([item("a", "1", 1, { groupLabel: "Recent" })], () => {});
    expect(rows[0]).toMatchObject({ label: "RECENT", disabled: true });
  });

  it("calls back with the chosen item and shows its accelerator", () => {
    const chosen: string[] = [];
    const rows = menuRows([item("a", "1", 1, { accelerator: "F1" })], (entry) => chosen.push(entry.id));
    rows[0].onselect?.();
    expect(chosen).toEqual(["a"]);
    expect(rows[0].shortcut).toBe("F1");
  });
});

describe("core menu", () => {
  it("gives every menu at least one item and every item a command", () => {
    for (const menu of CORE_MENUS) {
      expect(itemsForMenu(CORE_MENU_ITEMS, menu.id).length).toBeGreaterThan(0);
    }
    for (const entry of CORE_MENU_ITEMS) {
      expect(entry.commandId).toBeTruthy();
    }
  });

  it("has unique item ids", () => {
    const ids = CORE_MENU_ITEMS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
