// The `menus` service: the app menu as a registry any plugin adds to. Ported from Grove's
// `menu` registry. A top-level menu has an id, a label and an order, and an item names the
// menu it belongs to and, usually, the command it runs. What an item does and whether it can
// run now is the menu bar's business, not the registry's. Registrations leave with their plugin.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { MenuBarItem, TopMenu } from "./menuModel";

declare module "@neoworks/extension-system" {
  interface Context {
    menus: MenusService;
  }
}

export class MenusService extends Service {
  private menuList: TopMenu[] = [];
  private itemList: MenuBarItem[] = [];
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "menus");
  }

  /**
   * Adds a top-level menu, replacing one with the same id. It leaves with the calling plugin,
   * or when the returned function is called.
   */
  registerMenu(menu: TopMenu): () => void {
    return this.ctx.effect(() => {
      this.menuList = [...this.menuList.filter((existing) => existing.id !== menu.id), menu];
      this.changes.notify();
      return () => {
        this.menuList = this.menuList.filter((existing) => existing !== menu);
        this.changes.notify();
      };
    }, `menus.registerMenu(${menu.id})`);
  }

  /**
   * Adds items, replacing any with the same ids. They leave with the calling plugin, or when
   * the returned function is called. An item whose menu does not exist stays out of sight.
   */
  registerItems(items: MenuBarItem[]): () => void {
    return this.ctx.effect(() => {
      const ids = new Set(items.map((item) => item.id));
      this.itemList = [...this.itemList.filter((existing) => !ids.has(existing.id)), ...items];
      this.changes.notify();
      return () => {
        this.itemList = this.itemList.filter((existing) => !items.includes(existing));
        this.changes.notify();
      };
    }, `menus.registerItems(${items.length})`);
  }

  /** The top-level menus, in order. Reactive. */
  menus(): TopMenu[] {
    this.changes.track();
    return [...this.menuList].sort((first, second) => first.order - second.order);
  }

  /** Every registered item, unsorted and unfiltered; `itemsForMenu` orders and filters them. Reactive. */
  items(): MenuBarItem[] {
    this.changes.track();
    return this.itemList;
  }
}
