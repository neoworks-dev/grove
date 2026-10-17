// The menus plugin provides the `menus` service. `core-menu` is a second plugin that fills it
// with Grove's base menus, so a profile can drop them and keep the registry.

import type { Context } from "@neoworks/extension-system";
import { CORE_MENUS, CORE_MENU_ITEMS } from "./coreMenu";
import { MenusService } from "./service";

export const menus = {
  name: "menus",
  apply(ctx: Context) {
    new MenusService(ctx);
  },
};

export const coreMenu = {
  name: "core-menu",
  inject: ["menus"],
  apply(ctx: Context) {
    for (const menu of CORE_MENUS) {
      ctx.menus.registerMenu(menu);
    }
    ctx.menus.registerItems(CORE_MENU_ITEMS);
  },
};
