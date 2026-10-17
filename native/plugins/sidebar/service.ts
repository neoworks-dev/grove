// The `sidebar` service: the views that can fill the sidebar, and which one does. A view is one
// registration of the same id in two places, a button in the frame's `rail.left` list and an
// entry in the `sidebar` keyed slot, so a plugin adds a view with one call. Pressing a view's
// button opens it, and pressing it again closes the sidebar, as Grove's rail does. Which view
// is open is state here, read reactively by the rail buttons and the sidebar host.

import { Service, type Context } from "@neoworks/extension-system";
import type { Component } from "svelte";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { SlotsService } from "../../kernel/slots";
import type { RailsService } from "../rails/service";

declare module "@neoworks/extension-system" {
  interface Context {
    sidebar: SidebarService;
  }
}

export interface SidebarView {
  id: string;
  title: string;
  /** SVG markup, drawn on the rail button. */
  icon: string;
  /** Position on the rail, ascending. */
  order?: number;
  component: Component<any>;
  props?: Record<string, unknown>;
}

export class SidebarService extends Service {
  private slots: SlotsService;
  private rails: RailsService;
  private viewList: SidebarView[] = [];
  private openId: string | null = null;
  private lastOpenId: string | null = null;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, openAtStart?: string) {
    super(ctx, "sidebar");
    this.slots = ctx.slots;
    this.rails = ctx.rails;
    if (openAtStart !== undefined) {
      this.openId = openAtStart;
      this.lastOpenId = openAtStart;
    }
  }

  /**
   * Adds a view: a rail button and a sidebar entry under one id. It leaves with the calling
   * plugin, or when the returned function is called.
   */
  registerView(view: SidebarView): () => void {
    return this.ctx.effect(() => {
      const removeButton = this.rails.addItem("left", {
        id: `sidebar.${view.id}`,
        icon: view.icon,
        title: view.title,
        order: view.order,
        active: () => this.isOpen(view.id),
        onselect: () => this.toggle(view.id),
      });
      const removeEntry = this.slots.register("sidebar", {
        id: view.id,
        key: view.id,
        component: view.component,
        props: view.props,
      });
      this.viewList = [...this.viewList, view];
      this.changes.notify();
      return () => {
        removeButton();
        removeEntry();
        this.viewList = this.viewList.filter((existing) => existing !== view);
        this.changes.notify();
      };
    }, `sidebar.registerView(${view.id})`);
  }

  /** The registered views, in rail order. Reactive. */
  views(): SidebarView[] {
    this.changes.track();
    return [...this.viewList].sort((first, second) => orderOf(first) - orderOf(second));
  }

  /** The view the sidebar shows, or null while it is closed or the open view is gone. Reactive. */
  activeView(): SidebarView | null {
    this.changes.track();
    const found = this.viewList.find((view) => view.id === this.openId);
    if (!found) {
      return null;
    }
    return found;
  }

  /** Whether this view is the one shown. Reactive. */
  isOpen(viewId: string): boolean {
    this.changes.track();
    return this.openId === viewId;
  }

  /** Shows a view in the sidebar. */
  open(viewId: string): void {
    this.openId = viewId;
    this.lastOpenId = viewId;
    this.changes.notify();
  }

  /** Closes the sidebar, remembering what it showed. */
  close(): void {
    this.openId = null;
    this.changes.notify();
  }

  /** Opens a view, or closes the sidebar when that view is already the one shown. */
  toggle(viewId: string): void {
    if (this.openId === viewId) {
      this.close();
      return;
    }
    this.open(viewId);
  }

  /** Closes the sidebar if it is open; otherwise reopens the view it last showed, or the first one. */
  toggleVisible(): void {
    if (this.activeView() !== null) {
      this.close();
      return;
    }
    const remembered = this.viewList.find((view) => view.id === this.lastOpenId);
    if (remembered) {
      this.open(remembered.id);
      return;
    }
    const first = this.views()[0];
    if (first) {
      this.open(first.id);
    }
  }
}

/** A view's rail position with the default filled in. */
function orderOf(view: SidebarView): number {
  if (view.order === undefined) {
    return 0;
  }
  return view.order;
}
