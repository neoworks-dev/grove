// Whether the settings page is open and which row it shows. A plain class with a ChangeSignal,
// like the services, so the commands and the overlay share it through the plugin's props.

import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";

export class SettingsViewState {
  private openFlag = false;
  private selectedId: string | null = null;
  private changes: ChangeSignal = createChangeSignal();

  /** Whether the page is showing. Reactive. */
  isOpen(): boolean {
    this.changes.track();
    return this.openFlag;
  }

  /** The row whose form is shown, or null before the user picks one. Reactive. */
  selectedRowId(): string | null {
    this.changes.track();
    return this.selectedId;
  }

  /** Shows the page, on `rowId`'s form when one is given. */
  open(rowId?: string): void {
    if (rowId !== undefined) {
      this.selectedId = rowId;
    }
    this.openFlag = true;
    this.changes.notify();
  }

  /** Hides the page. */
  close(): void {
    this.openFlag = false;
    this.changes.notify();
  }

  /** Shows the form of another row. */
  select(rowId: string): void {
    this.selectedId = rowId;
    this.changes.notify();
  }
}
