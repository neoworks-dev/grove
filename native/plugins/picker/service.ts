// The `picker` service: one overlay that lists results beside a preview of the selected one, for
// plugins that find things (files, text) and open them. A plugin describes where its items come
// from with a `PickerSource`; the service holds the session that is showing, and the card
// (`PickerCard.svelte`) holds the query, the highlighted row and what was loaded. Plain class
// with a ChangeSignal, like the palette it borrows its matcher from.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { Searchable } from "../palette/fuzzy";

declare module "@neoworks/extension-system" {
  interface Context {
    picker: PickerService;
  }
}

/** What the preview shows for an item: the file, and where in it. Lines and columns count from zero. */
export interface PreviewTarget {
  /** The absolute path of the file. */
  path: string;
  line: number;
  column: number;
  /** When set, the text from `column` to here on `line` is highlighted. */
  endColumn?: number;
}

export interface PickerItem extends Searchable {
  id: string;
  /** Dim text beside the title in the list. */
  detail?: string;
  /** Where the item is, in full, shown under the list while the item is highlighted. */
  location?: string;
  target: PreviewTarget;
}

/** What a source loaded: the items, and a sentence to show when there are none or the list is cut. */
export interface PickerLoad {
  items: PickerItem[];
  message?: string;
}

export interface PickerSource {
  placeholder: string;
  /**
   * `filter` loads once, when the picker opens, and ranks the items by the query as it is typed.
   * `live` loads again for every query, once typing pauses, and lists what the source returns.
   */
  mode: "filter" | "live";
  /** The items for a query; in `filter` mode the query is empty. */
  load(query: string): Promise<PickerLoad>;
  /** Acts on the item that was chosen. */
  choose(item: PickerItem): void;
}

/** What the picker is showing. */
export interface PickerSession {
  source: PickerSource;
}

export class PickerService extends Service {
  static inject = ["palette"];

  private current: PickerSession | null = null;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "picker");
    ctx.effect(() => () => this.close(), "picker.close");
  }

  /** What the picker shows now, or null while it is closed. Reactive. */
  session(): PickerSession | null {
    this.changes.track();
    return this.current;
  }

  /** Whether the picker is showing. Reactive. */
  isOpen(): boolean {
    return this.session() !== null;
  }

  /** Shows the picker for a source, in place of any picker that was open. */
  open(source: PickerSource): void {
    this.current = { source };
    this.changes.notify();
  }

  /** Closes the picker. */
  close(): void {
    if (this.current === null) {
      return;
    }
    this.current = null;
    this.changes.notify();
  }

  /** Closes the picker and lets the source act on the item. */
  choose(item: PickerItem): void {
    const session = this.current;
    this.close();
    if (session !== null) {
      session.source.choose(item);
    }
  }

  /** The items that match the query, best first. */
  rank<T extends Searchable>(items: T[], query: string): T[] {
    return this.ctx.palette.rank(items, query);
  }
}
