import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import type { Component } from "svelte";
import { bootKernel } from "../kernel/boot";
import type { ProfileFiles, ProfileRow } from "../kernel/profile";
import { leaves } from "../plugins/layout/layoutTree";
import { LayoutService } from "../plugins/layout/service";
import { MenusService } from "../plugins/menus/service";
import { RailsService } from "../plugins/rails/service";
import { SidebarService } from "../plugins/sidebar/service";

const stub = (() => {}) as unknown as Component<any>;

/** Profile files held in memory: a user profile text, no config of its own otherwise, no folder. */
function files(userProfile: string | null): ProfileFiles {
  return {
    async readIfExists(path) {
      if (path === "/config/grove/profile.json") {
        return userProfile;
      }
      return null;
    },
    async configDirectory() {
      return "/config";
    },
    async openedFolder() {
      return null;
    },
  };
}

/** The shell's services and two contributors, as the real plugins wire them but over stub components. */
const catalog = {
  frame: {
    name: "frame",
    inject: ["slots"],
    apply(ctx: Context) {
      ctx.slots.declare("rail.left", "list");
      ctx.slots.declare("sidebar", "keyed");
    },
  },
  rails: {
    name: "rails",
    inject: ["slots"],
    apply(ctx: Context) {
      new RailsService(ctx, stub);
    },
  },
  sidebar: {
    name: "sidebar",
    inject: ["slots", "rails"],
    apply(ctx: Context, config: { open?: string } | undefined) {
      let open: string | undefined;
      if (config) {
        open = config.open;
      }
      new SidebarService(ctx, open);
    },
  },
  explorer: {
    name: "explorer",
    inject: ["sidebar"],
    apply(ctx: Context) {
      ctx.sidebar.registerView({ id: "explorer", title: "Explorer", icon: "", order: 1, component: stub });
    },
  },
  git: {
    name: "git",
    inject: ["sidebar"],
    apply(ctx: Context) {
      ctx.sidebar.registerView({ id: "git", title: "Git", icon: "", order: 2, component: stub });
    },
  },
};

const coreRows: ProfileRow[] = [
  { id: "frame", plugin: "frame" },
  { id: "rails", plugin: "rails" },
  { id: "sidebar", plugin: "sidebar", config: { open: "explorer" } },
  { id: "explorer", plugin: "explorer" },
  { id: "git", plugin: "git" },
];

/** Ids of what a slot currently renders. */
function ids(slot: { id: string }[]): string[] {
  return slot.map((entry) => entry.id);
}

describe("sidebar views", () => {
  test("a view is one id in rail.left and the same key in sidebar", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files(null) });
    await kernel.loaded;
    expect(ids(kernel.slots.entries("rail.left"))).toEqual(["sidebar.explorer", "sidebar.git"]);
    const sidebarEntries = kernel.slots.entries("sidebar");
    expect(sidebarEntries.map((entry) => entry.key)).toEqual(["explorer", "git"]);
  });

  test("the configured view starts open, and pressing a view again closes the sidebar", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files(null) });
    await kernel.loaded;
    const sidebar = kernel.context.sidebar;
    expect(sidebar.activeView()?.id).toBe("explorer");
    sidebar.toggle("git");
    expect(sidebar.activeView()?.id).toBe("git");
    expect(sidebar.isOpen("explorer")).toBe(false);
    sidebar.toggle("git");
    expect(sidebar.activeView()).toBeNull();
  });

  test("toggleVisible reopens the view that was last shown", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files(null) });
    await kernel.loaded;
    const sidebar = kernel.context.sidebar;
    sidebar.open("git");
    sidebar.toggleVisible();
    expect(sidebar.activeView()).toBeNull();
    sidebar.toggleVisible();
    expect(sidebar.activeView()?.id).toBe("git");
  });

  test("the rail button reads whether its view is open", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files(null) });
    await kernel.loaded;
    const buttons = kernel.slots.entries("rail.left");
    const explorerButton = buttons[0].props as { active: () => boolean; onselect: () => void };
    const gitButton = buttons[1].props as { active: () => boolean; onselect: () => void };
    expect([explorerButton.active(), gitButton.active()]).toEqual([true, false]);
    gitButton.onselect();
    expect([explorerButton.active(), gitButton.active()]).toEqual([false, true]);
  });
});

describe("profile layers", () => {
  test("disabling a plugin by id removes its view, its button and its open state", async () => {
    const kernel = await bootKernel({
      catalog,
      coreRows,
      files: files('[{"id":"explorer","disabled":true}]'),
    });
    await kernel.loaded;
    expect(ids(kernel.slots.entries("rail.left"))).toEqual(["sidebar.git"]);
    expect(kernel.slots.entries("sidebar").map((entry) => entry.key)).toEqual(["git"]);
    expect(kernel.context.sidebar.activeView()).toBeNull();
    expect(kernel.context.sidebar.views().map((view) => view.id)).toEqual(["git"]);
  });

  test("disabling the sidebar plugin leaves the rails service without a failure", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files('[{"id":"sidebar","disabled":true}]') });
    await kernel.loaded;
    expect(kernel.slots.entries("rail.left")).toEqual([]);
    const statuses = kernel.loader.reports().map((report) => [report.id, report.status]);
    expect(statuses).toContainEqual(["sidebar", "disabled"]);
    expect(kernel.loader.failures()).toEqual([]);
  });
});

describe("menus service", () => {
  /** A root context with the menus service mounted. */
  async function withMenus(): Promise<RootContext> {
    const root = new RootContext();
    await root.plugin({ name: "menus", apply: (ctx: Context) => void new MenusService(ctx) });
    return root;
  }

  test("registers menus in order and items by menu", async () => {
    const root = await withMenus();
    root.menus.registerMenu({ id: "view", label: "View", order: 2 });
    root.menus.registerMenu({ id: "file", label: "File", order: 1 });
    root.menus.registerItems([{ id: "a", menuId: "file", label: "A", commandId: "a.run" }]);
    expect(root.menus.menus().map((menu) => menu.id)).toEqual(["file", "view"]);
    expect(root.menus.items().map((item) => item.id)).toEqual(["a"]);
  });

  test("registering an id again replaces it", async () => {
    const root = await withMenus();
    root.menus.registerItems([{ id: "a", menuId: "file", label: "Old" }]);
    root.menus.registerItems([{ id: "a", menuId: "file", label: "New" }]);
    expect(root.menus.items().map((item) => item.label)).toEqual(["New"]);
  });

  test("a plugin's menu entries leave with the plugin", async () => {
    const root = await withMenus();
    const fiber = root.plugin({
      name: "extra",
      inject: ["menus"],
      apply(ctx: Context) {
        ctx.menus.registerMenu({ id: "extra", label: "Extra", order: 9 });
        ctx.menus.registerItems([{ id: "extra.item", menuId: "extra", label: "Item" }]);
      },
    });
    await fiber;
    expect(root.menus.menus().map((menu) => menu.id)).toEqual(["extra"]);
    await fiber.dispose();
    expect(root.menus.menus()).toEqual([]);
    expect(root.menus.items()).toEqual([]);
  });
});

describe("layout service", () => {
  /** A root context with a layout of one editor pane. */
  async function withLayout(): Promise<LayoutService> {
    const root = new RootContext();
    await root.plugin({ name: "layout", apply: (ctx: Context) => void new LayoutService(ctx, "editor", "empty") });
    return root.layout;
  }

  /** The pane type ids in reading order. */
  function paneTypes(layout: LayoutService): string[] {
    return leaves(layout.root).map((leaf) => leaf.paneTypeId);
  }

  test("starts with the default pane focused", async () => {
    const layout = await withLayout();
    expect(paneTypes(layout)).toEqual(["editor"]);
    expect(layout.focusedLeafId).toBe(leaves(layout.root)[0].id);
  });

  test("splitting puts a new pane after the focused one and focuses it", async () => {
    const layout = await withLayout();
    layout.splitFocused("row");
    expect(paneTypes(layout)).toEqual(["editor", "empty"]);
    expect(layout.focusedLeafId).toBe(leaves(layout.root)[1].id);
    layout.splitFocused("column");
    expect(layout.root.kind).toBe("split");
    expect(layout.leafCount()).toBe(3);
  });

  test("focusNext cycles through the panes and wraps", async () => {
    const layout = await withLayout();
    layout.splitFocused("row");
    const [first, second] = leaves(layout.root);
    layout.focusNext();
    expect(layout.focusedLeafId).toBe(first.id);
    layout.focusNext();
    expect(layout.focusedLeafId).toBe(second.id);
  });

  test("closing a pane gives its space to the rest and moves focus off it", async () => {
    const layout = await withLayout();
    layout.splitFocused("row");
    const closedId = layout.focusedLeafId;
    layout.closeFocused();
    expect(paneTypes(layout)).toEqual(["editor"]);
    expect(layout.focusedLeafId).not.toBe(closedId);
    expect(layout.root.kind).toBe("leaf");
  });

  test("the last pane cannot be closed", async () => {
    const layout = await withLayout();
    layout.closeFocused();
    expect(layout.leafCount()).toBe(1);
  });

  test("resizing moves the boundary between two panes", async () => {
    const layout = await withLayout();
    layout.splitFocused("row");
    const root = layout.root;
    if (root.kind !== "split") {
      throw new Error("expected a split");
    }
    layout.resize(root.id, 0, 0.2, 0.05, 0.05);
    const resized = layout.root;
    if (resized.kind !== "split") {
      throw new Error("expected a split");
    }
    expect(resized.sizes[0]).toBeCloseTo(0.7);
    expect(resized.sizes[1]).toBeCloseTo(0.3);
  });

  test("dropping a pane on another's edge splits that pane", async () => {
    const layout = await withLayout();
    layout.splitFocused("row");
    const [editorLeaf, emptyLeaf] = leaves(layout.root);
    layout.dropPane(emptyLeaf.id, editorLeaf.id, "bottom");
    expect(paneTypes(layout)).toEqual(["editor", "empty"]);
    const root = layout.root;
    expect(root.kind === "split" && root.direction).toBe("column");
  });

  test("a drag past the collapse point marks the pane until it closes", async () => {
    const layout = await withLayout();
    layout.splitFocused("row");
    const [, emptyLeaf] = leaves(layout.root);
    layout.collapsingLeafId = emptyLeaf.id;
    expect(layout.collapsingLeafId).toBe(emptyLeaf.id);
    layout.closeLeaf(emptyLeaf.id);
    expect(layout.collapsingLeafId).toBeNull();
  });
});
