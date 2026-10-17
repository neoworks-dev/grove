// The `palette` service: the command palette and the picker built on it. Opening it with no
// arguments lists every command that can run now, with its group and its keys; `pick` lists
// whatever items the caller gives and resolves with the one chosen. Which is shown, the query
// and the highlighted row are state of the palette's card (`PaletteOverlay.svelte`), so only the
// session lives here.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { Command } from "../../kernel/commands";
import type { Searchable } from "./fuzzy";

declare module "@neoworks/extension-system" {
  interface Context {
    palette: PaletteService;
  }
}

export interface PaletteItem extends Searchable {
  id: string;
  /** Dim text after the title: a command's group. */
  detail?: string;
  /** The keys that run it, one keycap per step. */
  keys?: string[];
}

export interface PickOptions {
  placeholder?: string;
  /** The item to highlight first. */
  activeId?: string;
}

/** What the palette is showing. */
export interface PaletteSession {
  placeholder: string;
  /** The item to highlight first. */
  activeId?: string;
  /** Items of a picker; undefined for the command list, which is built when the card draws. */
  items?: PaletteItem[];
}

interface OpenPick {
  session: PaletteSession;
  resolve: (item: PaletteItem | undefined) => void;
}

const COMMANDS_PLACEHOLDER = "Type a command";

export class PaletteService extends Service {
  static inject = ["commands", "keymap"];

  private current: PaletteSession | null = null;
  private pending: OpenPick | null = null;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "palette");
    ctx.effect(() => () => this.close(), "palette.close");
  }

  /** What the palette shows now, or null while it is closed. Reactive. */
  session(): PaletteSession | null {
    this.changes.track();
    return this.current;
  }

  /** Whether the palette is showing. Reactive. */
  isOpen(): boolean {
    return this.session() !== null;
  }

  /** Opens the command list. */
  open(): void {
    this.settlePick(undefined);
    this.current = { placeholder: COMMANDS_PLACEHOLDER };
    this.changes.notify();
  }

  /** Closes the palette; a picker that was open resolves with nothing. */
  close(): void {
    this.settlePick(undefined);
    this.current = null;
    this.changes.notify();
  }

  /** Opens the command list, or closes the palette when it is already showing. */
  toggle(): void {
    if (this.current) {
      this.close();
      return;
    }
    this.open();
  }

  /** Shows these items and resolves with the chosen one, or undefined when the palette is dismissed. */
  pick(items: PaletteItem[], options: PickOptions = {}): Promise<PaletteItem | undefined> {
    this.settlePick(undefined);
    let placeholder = "Select";
    if (options.placeholder !== undefined) {
      placeholder = options.placeholder;
    }
    const session: PaletteSession = { placeholder, activeId: options.activeId, items };
    return new Promise((resolve) => {
      this.pending = { session, resolve };
      this.current = session;
      this.changes.notify();
    });
  }

  /** The items the card lists for a session: its picker items, or every command that can run now. Reactive. */
  itemsFor(session: PaletteSession): PaletteItem[] {
    if (session.items) {
      return session.items;
    }
    const commands = this.ctx.commands;
    return commands
      .list()
      .filter((command) => commands.canRun(command.id))
      .sort(compareCommands)
      .map((command) => ({
        id: command.id,
        title: command.title,
        detail: command.group,
        extra: `${command.group ?? ""} ${command.keywords ?? ""} ${command.id}`,
        keys: this.ctx.keymap.keysFor(command.id),
      }));
  }

  /** Acts on the item chosen in the card: a picker resolves with it, a command list runs the command. */
  choose(item: PaletteItem): void {
    const pending = this.pending;
    this.pending = null;
    this.current = null;
    this.changes.notify();
    if (pending) {
      pending.resolve(item);
      return;
    }
    void this.ctx.commands.run(item.id);
  }

  /** Resolves an open picker with a result, so its caller is never left waiting. */
  private settlePick(item: PaletteItem | undefined): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      pending.resolve(item);
    }
  }
}

/** Orders commands by group and then title, which is the order of the list before anything is typed. */
function compareCommands(first: Command, second: Command): number {
  const groupOrder = groupOf(first).localeCompare(groupOf(second));
  if (groupOrder !== 0) {
    return groupOrder;
  }
  return first.title.localeCompare(second.title);
}

/** A command's group, empty for one without. */
function groupOf(command: Command): string {
  if (command.group === undefined) {
    return "";
  }
  return command.group;
}
