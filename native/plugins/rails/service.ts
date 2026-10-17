// The `rails` service: icon buttons on the left and right rails. A button is one entry in the
// frame's `rail.left` or `rail.right` list slot, so the rail's order and its overrides are the
// slot's. The sidebar adds a button per view through this; anything else that wants a rail
// button, such as a toggle for a right-hand pane, does the same.

import { Service, type Context } from "@neoworks/extension-system";
import type { SlotsService } from "../../kernel/slots";
import type { Component } from "svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    rails: RailsService;
  }
}

export type RailSide = "left" | "right";

export interface RailItem {
  id: string;
  /** SVG markup. */
  icon: string;
  title: string;
  order?: number;
  /** Whether the button looks pressed; read reactively. */
  active: () => boolean;
  onselect: () => void;
}

export class RailsService extends Service {
  private slots: SlotsService;
  private buttonComponent: Component<any>;

  /** `buttonComponent` draws one button; it is given by the plugin so the service itself stays free of Svelte files. */
  constructor(ctx: Context, buttonComponent: Component<any>) {
    super(ctx, "rails");
    this.slots = ctx.slots;
    this.buttonComponent = buttonComponent;
  }

  /** Adds a button to a rail. It leaves with the calling plugin, or when the returned function is called. */
  addItem(side: RailSide, item: RailItem): () => void {
    return this.ctx.effect(() => {
      const props = { icon: item.icon, title: item.title, active: item.active, onselect: item.onselect, tooltipSide: tooltipSideOf(side) };
      const remove = this.slots.register(`rail.${side}`, { id: item.id, order: item.order, component: this.buttonComponent, props });
      return () => remove();
    }, `rails.addItem(${side}, ${item.id})`);
  }
}

/** Tooltips open toward the middle of the window. */
function tooltipSideOf(side: RailSide): "left" | "right" {
  if (side === "left") {
    return "right";
  }
  return "left";
}
