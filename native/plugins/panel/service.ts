// The `panel` service: whether the bottom panel is open and which tab it shows. The tabs are
// not registered here. A plugin adds one by registering into the keyed `panel.bottom` slot with
// the tab's id as the key and its title and icon in the entry's props, and the panel draws one
// tab per entry.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";

declare module "@neoworks/extension-system" {
  interface Context {
    panel: PanelService;
  }
}

export class PanelService extends Service {
  private openState: boolean;
  private activeTabId = "";
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, openAtStart: boolean) {
    super(ctx, "panel");
    this.openState = openAtStart;
  }

  /** Whether the panel is showing. Reactive. */
  isOpen(): boolean {
    this.changes.track();
    return this.openState;
  }

  /** The id of the tab last chosen; empty until one is. The panel falls back to its first tab. Reactive. */
  activeId(): string {
    this.changes.track();
    return this.activeTabId;
  }

  /** Shows the panel. */
  open(): void {
    this.openState = true;
    this.changes.notify();
  }

  /** Hides the panel. */
  close(): void {
    this.openState = false;
    this.changes.notify();
  }

  /** Shows the panel if it is hidden, hides it if it is showing. */
  toggle(): void {
    this.openState = !this.openState;
    this.changes.notify();
  }

  /** Chooses the tab to show. */
  select(tabId: string): void {
    this.activeTabId = tabId;
    this.changes.notify();
  }
}
